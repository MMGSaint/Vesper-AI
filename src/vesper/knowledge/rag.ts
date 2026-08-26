import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { KnowledgeHit, KnowledgeSource } from "../types.ts";
import {
  containsTraversal,
  isDangerousRoot,
  isPathInside,
  resolveRealWithinRoot,
} from "../security.ts";
import { chunkText } from "./chunk.ts";
import {
  cosineSimilarity,
  createHashEmbeddings,
  type EmbeddingProvider,
} from "./embeddings.ts";
import { excludesDirectory, includesFile, normalizeRelPath } from "./glob.ts";
import { bm25, buildLexicalIndex, tokenize, type LexicalIndex } from "./lexical.ts";

const TEXT_EXT = new Set([".md", ".txt", ".json", ".ts", ".js", ".cs", ".yml", ".yaml"]);

const LEXICAL_WEIGHT = 0.65;
const DENSE_WEIGHT = 0.35;
const PHRASE_BONUS = 0.15;
/** A document with no lexical overlap needs real dense agreement to be worth showing. */
const DENSE_ONLY_FLOOR = 0.15;

export interface KnowledgeDocument {
  sourceId: string;
  path: string;
  title: string;
  text: string;
  offset?: number;
}

export interface ReindexStats {
  documents: number;
  filesSeen: number;
  filesRead: number;
  filesReused: number;
  filesDropped: number;
  /** False when nothing changed and the existing dense vectors were kept. */
  embedded: boolean;
}

interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  docs: KnowledgeDocument[];
}

interface WalkFilter {
  base: string;
  include?: string[];
  exclude?: string[];
}

async function walk(
  root: string,
  acc: WalkedFile[],
  approvedRoots: string[],
  filter: WalkFilter,
): Promise<void> {
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

    // A symlink can point anywhere. `readdir` reports the link itself, so a link named
    // `notes.md` would otherwise be indexed by extension and read through to its real
    // target outside the approved tree.
    if (entry.isSymbolicLink()) {
      const real = await resolveRealWithinRoot(resolvedRoot, full);
      if (!real.ok) continue;
    }

    const rel = normalizeRelPath(relative(filter.base, full) || entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "bin") continue;
      if (excludesDirectory(rel, filter.exclude)) continue;
      await walk(full, acc, approvedRoots.length ? approvedRoots : [resolvedRoot], filter);
    } else if (TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      if (!includesFile(rel, filter)) continue;
      // One unreadable or racing entry must not abandon the whole index.
      try {
        const info = await stat(full);
        if (info.size <= 256_000) acc.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        continue;
      }
    }
  }
}

export class KnowledgeIndex {
  private documents: KnowledgeDocument[] = [];
  private sources: KnowledgeSource[];
  private seed: KnowledgeDocument[];
  private readonly approvedRoots: string[];
  readonly embeddings: EmbeddingProvider;
  private vectors: number[][] | null = null;
  /** Which provider produced `vectors`, so diagnostics can name the embedding space. */
  private vectorProviderId: string | null = null;
  private lastError: string | null = null;
  private lexical: LexicalIndex | null = null;
  /** mtime+size per indexed file, so an unchanged tree is not re-read on every reindex. */
  private readonly fileCache = new Map<string, CachedFile>();
  private documentSignature = "";
  private lastStats: ReindexStats | null = null;

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

  lastIndexStats(): ReindexStats | null {
    return this.lastStats ? { ...this.lastStats } : null;
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
    const known = new Set(this.sources.map((source) => source.id));
    // Re-adding `seed` here duplicated every seeded document that reindex had already
    // chunked into `documents`; the surviving documents are already the right set.
    this.seed = this.seed.filter((doc) => known.has(doc.sourceId));
    this.documents = this.documents.filter((doc) => known.has(doc.sourceId));
    for (const key of [...this.fileCache.keys()]) {
      if (key.startsWith(`${id} `)) this.fileCache.delete(key);
    }
    this.vectors = null;
    this.vectorProviderId = null;
    this.documentSignature = "";
    this.invalidate();
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
    const seen = new Set<string>();
    let filesRead = 0;
    let filesReused = 0;
    for (const source of this.sources.filter((item) => item.enabled)) {
      for (const root of source.roots) {
        const files: WalkedFile[] = [];
        await walk(root, files, this.approvedRoots, {
          base: resolve(root),
          include: source.include,
          exclude: source.exclude,
        });
        // Directory order is not guaranteed stable and document order has to be, because
        // dense vectors are addressed by document index.
        files.sort((a, b) => a.path.localeCompare(b.path));
        for (const file of files) {
          const cacheKey = cacheKeyFor(source.id, root, file.path);
          seen.add(cacheKey);
          const cached = this.fileCache.get(cacheKey);
          if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
            filesReused += 1;
            docs.push(...cached.docs);
            continue;
          }
          try {
            const text = await readFile(file.path, "utf8");
            const rel = relative(root, file.path) || file.path;
            const title = file.path.split(/[\\/]/).at(-1) ?? file.path;
            const built = chunkText(text).map((chunk) => ({
              sourceId: source.id,
              path: rel,
              title,
              text: chunk.text,
              offset: chunk.offset,
            }));
            this.fileCache.set(cacheKey, { mtimeMs: file.mtimeMs, size: file.size, docs: built });
            docs.push(...built);
            filesRead += 1;
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.fileCache.delete(cacheKey);
          }
        }
      }
    }
    let filesDropped = 0;
    for (const key of [...this.fileCache.keys()]) {
      if (!seen.has(key)) {
        this.fileCache.delete(key);
        filesDropped += 1;
      }
    }

    const signature = signatureOf(docs);
    const unchanged =
      signature === this.documentSignature &&
      this.vectors !== null &&
      this.vectors.length === docs.length &&
      this.vectorProviderId === this.embeddings.id;
    this.documents = docs;
    if (signature !== this.documentSignature) {
      this.documentSignature = signature;
      this.invalidate();
    }

    let embedded = false;
    if (!unchanged) {
      this.vectors = null;
      this.vectorProviderId = null;
      if (this.embeddings.available() && docs.length) {
        try {
          this.vectors = await this.embeddings.embed(docs.map((doc) => `${doc.title}\n${doc.text}`));
          this.vectorProviderId = this.vectors ? this.embeddings.id : null;
          embedded = this.vectors !== null;
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.vectors = null;
          this.vectorProviderId = null;
        }
      }
    }
    this.lastStats = {
      documents: docs.length,
      filesSeen: seen.size,
      filesRead,
      filesReused,
      filesDropped,
      embedded,
    };
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

  private invalidate() {
    this.lexical = null;
  }

  private lexicalIndex(): LexicalIndex {
    // IDF is measured over the whole indexed corpus rather than the workspace-filtered
    // subset, so a term does not change weight depending on who is asking.
    if (!this.lexical) {
      this.lexical = buildLexicalIndex(this.documents.map((doc) => `${doc.title}\n${doc.text}`));
    }
    return this.lexical;
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
    const lexicalIndex = this.lexicalIndex();
    const queryTokens = tokenize(query);
    const phrase = query.trim().toLowerCase();
    const scored = this.documents
      .map((doc, index) => ({ doc, index }))
      .filter((row) => allowedSources.has(row.doc.sourceId))
      .map((row) => {
        const lexical = queryTokens.length ? bm25(queryTokens, lexicalIndex, row.index) : 0;
        const docVec = this.vectors?.[row.index];
        const dense = queryVec && docVec ? cosineSimilarity(queryVec, docVec) : 0;
        const idx = phrase ? row.doc.text.toLowerCase().indexOf(phrase) : -1;
        const snippet =
          idx >= 0
            ? row.doc.text.slice(Math.max(0, idx - 80), idx + phrase.length + 120).trim()
            : row.doc.text.slice(0, 180).trim();
        return {
          doc: row.doc,
          snippet,
          phraseHit: idx >= 0,
          lexical,
          dense: Math.max(0, dense),
        };
      });

    // BM25 is unbounded and its absolute scale depends on corpus size and document
    // length, while cosine similarity is already bounded. Mixing them against a fixed
    // constant would weight the two signals differently on every corpus, so the lexical
    // side is normalised against the best match for *this* query.
    const bestLexical = scored.reduce((max, row) => Math.max(max, row.lexical), 0);

    const ranked = scored
      .map((row) => ({
        ...row,
        score:
          (bestLexical > 0 ? row.lexical / bestLexical : 0) * LEXICAL_WEIGHT +
          row.dense * DENSE_WEIGHT +
          (row.phraseHit ? PHRASE_BONUS : 0),
      }))
      .filter((row) => row.lexical > 0 || row.dense >= DENSE_ONLY_FLOOR)
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, options?.limit ?? 8).map(
      (row) =>
        ({
          sourceId: row.doc.sourceId,
          path: row.doc.path,
          title: row.doc.title,
          snippet: row.snippet,
          score: row.score,
          provenance: {
            sourceId: row.doc.sourceId,
            path: row.doc.path,
            offset: row.doc.offset ?? 0,
          },
        }) satisfies KnowledgeHit,
    );
  }

  addSeed(doc: KnowledgeDocument) {
    this.documents.push(doc);
    this.seed.push(doc);
    this.vectors = null;
    this.vectorProviderId = null;
    this.documentSignature = "";
    this.invalidate();
  }
}

function cacheKeyFor(sourceId: string, root: string, path: string): string {
  return `${sourceId} ${root} ${path}`;
}

function signatureOf(docs: KnowledgeDocument[]): string {
  let hash = 2166136261;
  for (const doc of docs) {
    const line = `${doc.sourceId}|${doc.path}|${doc.offset ?? 0}|${doc.text.length}|${doc.title}`;
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${docs.length}:${(hash >>> 0).toString(36)}`;
}
