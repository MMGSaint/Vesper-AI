import { createId, nowIso } from "../id.ts";
import type { StorageAdapter } from "../storage.ts";
import { MEMORY_CATEGORIES, type JsonValue, type MemoryCategory, type MemoryEntry } from "../types.ts";

const KEY = "memory.entries";

function asEntries(value: JsonValue | undefined): MemoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object") as unknown as MemoryEntry[];
}

function score(entry: MemoryEntry, query: string): number {
  const q = query.toLowerCase();
  let s = 0;
  if (entry.key.toLowerCase() === q) s += 8;
  if (entry.key.toLowerCase().includes(q)) s += 4;
  if (entry.value.toLowerCase().includes(q)) s += 3;
  if (entry.tags?.some((tag) => tag.toLowerCase().includes(q))) s += 2;
  if (entry.category.toLowerCase().includes(q)) s += 1;
  return s;
}

export class MemoryStore {
  private readonly storage: StorageAdapter;
  private sessionEntries: MemoryEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async loadPersistent(): Promise<MemoryEntry[]> {
    return asEntries(await this.storage.get(KEY));
  }

  private async savePersistent(entries: MemoryEntry[]) {
    await this.storage.set(KEY, entries as unknown as JsonValue);
  }

  private merged(persistent: MemoryEntry[]): MemoryEntry[] {
    return [...persistent, ...this.sessionEntries];
  }

  async remember(input: {
    category: MemoryCategory;
    key: string;
    value: string;
    workspaceId?: string;
    source?: MemoryEntry["source"];
    tags?: string[];
    provenance?: MemoryEntry["provenance"];
  }): Promise<MemoryEntry> {
    return this.runExclusive(async () => {
      const now = nowIso();
      const session = input.category === "session";
      const pool = session ? this.sessionEntries : await this.loadPersistent();
      const existing = pool.find(
        (entry) =>
          entry.key === input.key &&
          entry.category === input.category &&
          (entry.workspaceId ?? "") === (input.workspaceId ?? ""),
      );
      if (existing) {
        existing.value = input.value;
        existing.updatedAt = now;
        if (input.tags) existing.tags = input.tags;
        if (input.provenance) existing.provenance = input.provenance;
        if (!session) await this.savePersistent(pool);
        return existing;
      }
      const entry: MemoryEntry = {
        id: createId("mem"),
        category: input.category,
        key: input.key,
        value: input.value,
        workspaceId: input.workspaceId,
        createdAt: now,
        updatedAt: now,
        source: input.source ?? "user",
        tags: input.tags,
        provenance: input.provenance ?? {
          origin: input.source ?? "user",
          kind: input.source === "agent" ? "inferred" : "stated",
        },
      };
      pool.push(entry);
      if (!session) await this.savePersistent(pool);
      return entry;
    });
  }

  async retrieve(idOrKey: string, workspaceId?: string): Promise<MemoryEntry | undefined> {
    const entries = this.merged(await this.loadPersistent());
    return entries.find(
      (entry) =>
        (entry.id === idOrKey || entry.key === idOrKey) &&
        (workspaceId ? entry.workspaceId === workspaceId || !entry.workspaceId : true),
    );
  }

  async search(query: string, options?: { category?: MemoryCategory; workspaceId?: string; limit?: number }) {
    const entries = this.merged(await this.loadPersistent());
    const filtered = entries.filter((entry) => {
      if (options?.category && entry.category !== options.category) return false;
      if (options?.workspaceId && entry.workspaceId && entry.workspaceId !== options.workspaceId) {
        return false;
      }
      return score(entry, query) > 0 || query.trim() === "";
    });
    const ranked =
      query.trim() === ""
        ? filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : filtered
            .map((entry) => ({ entry, s: score(entry, query) }))
            .filter((row) => row.s > 0)
            .sort((a, b) => b.s - a.s)
            .map((row) => row.entry);
    return ranked.slice(0, options?.limit ?? 20);
  }

  async update(id: string, patch: Partial<Pick<MemoryEntry, "value" | "tags" | "category" | "key">>) {
    return this.runExclusive(async () => {
      const sessionHit = this.sessionEntries.find((item) => item.id === id);
      if (sessionHit) {
        applyPatch(sessionHit, patch);
        return sessionHit;
      }
      const entries = await this.loadPersistent();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return undefined;
      applyPatch(entry, patch);
      await this.savePersistent(entries);
      return entry;
    });
  }

  async forget(idOrKey: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const sessionNext = this.sessionEntries.filter(
        (entry) => entry.id !== idOrKey && entry.key !== idOrKey,
      );
      const sessionChanged = sessionNext.length !== this.sessionEntries.length;
      this.sessionEntries = sessionNext;
      const entries = await this.loadPersistent();
      const next = entries.filter((entry) => entry.id !== idOrKey && entry.key !== idOrKey);
      const persistentChanged = next.length !== entries.length;
      if (persistentChanged) await this.savePersistent(next);
      return sessionChanged || persistentChanged;
    });
  }

  async summarize(workspaceId?: string): Promise<string> {
    const entries = await this.search("", { workspaceId, limit: 50 });
    if (entries.length === 0) return "No stored memories.";
    const byCategory = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }
    const lines = [`${entries.length} memories`];
    for (const [category, list] of byCategory) {
      lines.push(`${category}: ${list.map((entry) => `${entry.key} — ${entry.value}`).join("; ")}`);
    }
    return lines.join("\n");
  }

  async all(): Promise<MemoryEntry[]> {
    return this.merged(await this.loadPersistent());
  }

  async stats(): Promise<{ persistent: number; session: number }> {
    const persistent = await this.loadPersistent();
    return { persistent: persistent.length, session: this.sessionEntries.length };
  }

  async exportPersistent(): Promise<MemoryEntry[]> {
    return (await this.loadPersistent()).map((entry) => structuredClone(entry));
  }

  async importPersistent(
    incoming: unknown,
    mode: "merge" | "replace" = "merge",
  ): Promise<{ imported: number; skipped: number }> {
    return this.runExclusive(async () => {
      const parsed = Array.isArray(incoming) ? incoming : [];
      const valid: MemoryEntry[] = [];
      let skipped = 0;
      for (const item of parsed) {
        const entry = normalizeImported(item);
        if (!entry) {
          skipped += 1;
          continue;
        }
        valid.push(entry);
      }
      if (mode === "replace") {
        await this.savePersistent(valid);
        return { imported: valid.length, skipped };
      }
      const current = await this.loadPersistent();
      for (const entry of valid) {
        const existing = current.find(
          (item) =>
            item.key === entry.key &&
            item.category === entry.category &&
            (item.workspaceId ?? "") === (entry.workspaceId ?? ""),
        );
        if (existing) {
          existing.value = entry.value;
          existing.updatedAt = nowIso();
          if (entry.tags) existing.tags = entry.tags;
        } else {
          current.push(entry);
        }
      }
      await this.savePersistent(current);
      return { imported: valid.length, skipped };
    });
  }

  clearSession() {
    this.sessionEntries = [];
  }
}

function applyPatch(
  entry: MemoryEntry,
  patch: Partial<Pick<MemoryEntry, "value" | "tags" | "category" | "key">>,
) {
  if (patch.value !== undefined) entry.value = patch.value;
  if (patch.tags !== undefined) entry.tags = patch.tags;
  if (patch.category !== undefined) entry.category = patch.category;
  if (patch.key !== undefined) entry.key = patch.key;
  entry.updatedAt = nowIso();
}

function normalizeImported(item: unknown): MemoryEntry | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.key !== "string" || rec.key.trim().length === 0) return null;
  if (typeof rec.value !== "string") return null;
  const category = MEMORY_CATEGORIES.includes(rec.category as MemoryCategory)
    ? (rec.category as MemoryCategory)
    : "fact";
  const source =
    rec.source === "agent" || rec.source === "seed" || rec.source === "system" || rec.source === "user"
      ? rec.source
      : "user";
  let provenance: MemoryEntry["provenance"] = { origin: "import", kind: "stated" };
  if (rec.provenance && typeof rec.provenance === "object" && !Array.isArray(rec.provenance)) {
    const raw = rec.provenance as { origin?: unknown; kind?: unknown };
    const kind = raw.kind === "stated" || raw.kind === "observed" || raw.kind === "inferred" ? raw.kind : "stated";
    provenance = {
      origin: typeof raw.origin === "string" ? raw.origin : "import",
      kind,
    };
  }
  return {
    id: typeof rec.id === "string" ? rec.id : createId("mem"),
    category,
    key: rec.key,
    value: rec.value,
    workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
    source,
    tags: Array.isArray(rec.tags) ? rec.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    provenance,
  };
}
