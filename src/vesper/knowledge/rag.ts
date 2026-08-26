import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { KnowledgeHit, KnowledgeSource } from "../types.ts";
import { containsTraversal, isDangerousRoot, isPathInside } from "../security.ts";
import { chunkText } from "./chunk.ts";
import {
  cosineSimilarity,
  createHashEmbeddings,
  type EmbeddingProvider,
} from "./embeddings.ts";

const TEXT_EXT = new Set([".md", ".txt", ".json", ".ts", ".js", ".cs", ".yml", ".yaml"]);

export interface KnowledgeDocument {
  sourceId: string;
  path: string;
  title: string;
  text: string;
  offset?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
}

function bm25ish(query: string, text: string): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const tTokens = tokenize(text);
  if (tTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const token of tTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of qTokens) {
    const freq = tf.get(token) ?? 0;
    if (freq === 0) continue;
    score += (freq * 2.2) / (freq + 1.5);
  }
  if (text.toLowerCase().includes(query.toLowerCase())) score += 2;
  return score;
}

async function walk(root: string, acc: string[], approvedRoots: string[]): Promise<void> {
  if (containsTraversal(root) || isDangerousRoot(root)) return;
  const resolvedRoot = resolve(root);
  if (approvedRoots.length && !approvedRoots.some((item) => isPathInside(item, resolvedRoot))) {
    return;
  }
  let entries;
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(resolvedRoot, entry.name);
    if (!isPathInside(resolvedRoot, full)) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "bin") continue;
      await walk(full, acc, approvedRoots.length ? approvedRoots : [resolvedRoot]);
    } else if (TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      const info = await stat(full);
      if (info.size <= 256_000) acc.push(full);
    }
  }
}

export class KnowledgeIndex {
  private documents: KnowledgeDocument[] = [];
  private sources: KnowledgeSource[];
  private readonly seed: KnowledgeDocument[];
  private readonly approvedRoots: string[];
  readonly embeddings: EmbeddingProvider;
  private vectors: number[][] | null = null;
  /** Which provider produced `vectors`, so diagnostics can name the embedding space. */
  private vectorProviderId: string | null = null;
  private lastError: string | null = null;

  constructor(
    sources: KnowledgeSource[],
    seed: KnowledgeDocument[] = [],
    options?: { approvedRoots?: string[]; embeddings?: EmbeddingProvider },
  ) {
    this.sources = sources.map((source) => ({ ...source }));
    this.seed = seed;
    this.documents = [...seed];
    this.approvedRoots = (options?.approvedRoots ?? []).map((root) => resolve(root));
    this.embeddings = options?.embeddings ?? createHashEmbeddings();
  }

  listSources(): KnowledgeSource[] {
    return this.sources.map((source) => ({ ...source }));
  }

  lastIndexError(): string | null {
    return this.lastError;
  }

  registerSource(source: KnowledgeSource): { ok: boolean; summary: string } {
    if (this.sources.some((item) => item.id === source.id)) {
      return { ok: false, summary: `Knowledge source '${source.id}' already exists.` };
    }
    if (source.roots.some((root) => containsTraversal(root) || isDangerousRoot(root))) {
      return { ok: false, summary: "Refused to register a dangerous or traversing knowledge root." };
    }
    if (this.approvedRoots.length) {
      const allowed = source.roots.every((root) =>
        this.approvedRoots.some((item) => isPathInside(item, resolve(root))),
      );
      if (!allowed) {
        return { ok: false, summary: "Knowledge roots must stay inside approved directories." };
      }
    }
    this.sources.push({ ...source });
    return { ok: true, summary: `Registered knowledge source '${source.id}'.` };
  }

  removeSource(id: string): { ok: boolean; summary: string } {
    const next = this.sources.filter((source) => source.id !== id);
    if (next.length === this.sources.length) {
      return { ok: false, summary: `No knowledge source '${id}'.` };
    }
    this.sources = next;
    this.documents = [
      ...this.seed.filter((doc) => this.sources.some((source) => source.id === doc.sourceId)),
      ...this.documents.filter(
        (doc) => this.sources.some((source) => source.id === doc.sourceId) && !this.seed.includes(doc),
      ),
    ];
    this.vectors = null;
    return { ok: true, summary: `Removed knowledge source '${id}'.` };
  }

  async reindex(): Promise<number> {
    const docs: KnowledgeDocument[] = [];
    for (const seed of this.seed) {
      const chunks = chunkText(seed.text);
      if (chunks.length <= 1) {
        docs.push({ ...seed, offset: 0 });
      } else {
        for (const chunk of chunks) {
          docs.push({
            sourceId: seed.sourceId,
            path: seed.path,
            title: seed.title,
            text: chunk.text,
            offset: chunk.offset,
          });
        }
      }
    }
    this.lastError = null;
    for (const source of this.sources.filter((item) => item.enabled)) {
      for (const root of source.roots) {
        const files: string[] = [];
        await walk(root, files, this.approvedRoots);
        for (const file of files) {
          try {
            const text = await readFile(file, "utf8");
            const rel = relative(root, file) || file;
            const title = file.split(/[\\/]/).at(-1) ?? file;
            const chunks = chunkText(text);
            for (const chunk of chunks) {
              docs.push({
                sourceId: source.id,
                path: rel,
                title,
                text: chunk.text,
                offset: chunk.offset,
              });
            }
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
          }
        }
      }
    }
    this.documents = docs;
    this.vectors = null;
    if (this.embeddings.available() && docs.length) {
      try {
        this.vectors = await this.embeddings.embed(docs.map((doc) => `${doc.title}\n${doc.text}`));
        this.vectorProviderId = this.vectors ? this.embeddings.id : null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.vectors = null;
        this.vectorProviderId = null;
      }
    }
    return docs.length;
  }

  /**
   * Synchronous retrieval. Only a lexical embedder can contribute a dense score here;
   * a model-backed embedder needs I/O, so callers that can await should prefer
   * `searchAsync` to get the better ranking.
   */
  search(query: string, options?: { workspaceId?: string; limit?: number }): KnowledgeHit[] {
    return this.rank(query, this.embeddings.embedSync?.(query), options);
  }

  /**
   * Retrieval with a model-backed query embedding when one is available. Falls back to
   * the synchronous path if the embedder cannot answer, so retrieval never fails shut.
   */
  async searchAsync(
    query: string,
    options?: { workspaceId?: string; limit?: number },
  ): Promise<KnowledgeHit[]> {
    if (this.embeddings.embedSync || !this.embeddings.available() || !this.vectors) {
      return this.search(query, options);
    }
    try {
      const vectors = await this.embeddings.embed([query]);
      return this.rank(query, vectors?.[0], options);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.rank(query, undefined, options);
    }
  }

  /** Embedding-space state, for diagnostics and honest status reporting. */
  embeddingStatus(): { providerId: string; indexedWith: string | null; detail: string } {
    return {
      providerId: this.embeddings.id,
      indexedWith: this.vectorProviderId,
      detail:
        this.embeddings.detail?.() ??
        (this.vectorProviderId
          ? `Index embedded with ${this.vectorProviderId}.`
          : "No dense vectors; retrieval is lexical only."),
    };
  }

  private rank(
    query: string,
    queryVec: number[] | undefined,
    options?: { workspaceId?: string; limit?: number },
  ): KnowledgeHit[] {
    const allowedSources = new Set(
      this.sources
        .filter((source) => {
          if (!source.enabled) return false;
          if (!options?.workspaceId || !source.workspaceIds?.length) return true;
          return source.workspaceIds.includes(options.workspaceId);
        })
        .map((source) => source.id),
    );
    const scored = this.documents
      .map((doc, index) => ({ doc, index }))
      .filter((row) => allowedSources.has(row.doc.sourceId))
      .map((row) => {
        const lexical = bm25ish(query, `${row.doc.title}\n${row.doc.text}`);
        const docVec = this.vectors?.[row.index];
        const dense = queryVec && docVec ? cosineSimilarity(queryVec, docVec) : 0;
        const idx = row.doc.text.toLowerCase().indexOf(query.toLowerCase());
        const snippet =
          idx >= 0
            ? row.doc.text.slice(Math.max(0, idx - 80), idx + query.length + 120).trim()
            : row.doc.text.slice(0, 180).trim();
        return {
          sourceId: row.doc.sourceId,
          path: row.doc.path,
          title: row.doc.title,
          snippet,
          score: lexical + dense * 2,
          provenance: {
            sourceId: row.doc.sourceId,
            path: row.doc.path,
            offset: row.doc.offset ?? 0,
          },
        } satisfies KnowledgeHit;
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, options?.limit ?? 8);
  }

  addSeed(doc: KnowledgeDocument) {
    this.documents.push(doc);
    this.seed.push(doc);
    this.vectors = null;
  }
}
