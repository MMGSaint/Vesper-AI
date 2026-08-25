import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { KnowledgeHit, KnowledgeSource } from "../types.ts";

const TEXT_EXT = new Set([".md", ".txt", ".json", ".ts", ".js", ".cs", ".yml", ".yaml"]);

export interface KnowledgeDocument {
  sourceId: string;
  path: string;
  title: string;
  text: string;
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

async function walk(root: string, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "bin") continue;
      await walk(full, acc);
    } else if (TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      const info = await stat(full);
      if (info.size <= 256_000) acc.push(full);
    }
  }
}

export class KnowledgeIndex {
  private documents: KnowledgeDocument[] = [];
  private readonly sources: KnowledgeSource[];
  private readonly seed: KnowledgeDocument[];

  constructor(sources: KnowledgeSource[], seed: KnowledgeDocument[] = []) {
    this.sources = sources;
    this.seed = seed;
    this.documents = [...seed];
  }

  async reindex(): Promise<number> {
    const docs: KnowledgeDocument[] = [...this.seed];
    for (const source of this.sources.filter((item) => item.enabled)) {
      for (const root of source.roots) {
        const files: string[] = [];
        await walk(root, files);
        for (const file of files) {
          try {
            const text = await readFile(file, "utf8");
            docs.push({
              sourceId: source.id,
              path: relative(root, file) || file,
              title: file.split(/[\\/]/).at(-1) ?? file,
              text,
            });
          } catch {
            // Skip unreadable files rather than failing the assistant.
          }
        }
      }
    }
    this.documents = docs;
    return docs.length;
  }

  search(query: string, options?: { workspaceId?: string; limit?: number }): KnowledgeHit[] {
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
      .filter((doc) => allowedSources.has(doc.sourceId))
      .map((doc) => {
        const score = bm25ish(query, `${doc.title}\n${doc.text}`);
        const idx = doc.text.toLowerCase().indexOf(query.toLowerCase());
        const snippet =
          idx >= 0
            ? doc.text.slice(Math.max(0, idx - 80), idx + query.length + 120).trim()
            : doc.text.slice(0, 180).trim();
        return {
          sourceId: doc.sourceId,
          path: doc.path,
          title: doc.title,
          snippet,
          score,
        } satisfies KnowledgeHit;
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, options?.limit ?? 8);
  }

  addSeed(doc: KnowledgeDocument) {
    this.documents.push(doc);
    this.seed.push(doc);
  }
}
