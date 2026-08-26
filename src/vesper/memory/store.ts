import { createId, nowIso } from "../id.ts";
import type { StorageAdapter } from "../storage.ts";
import type { JsonValue, MemoryCategory, MemoryEntry } from "../types.ts";
import { prepareQuery, scoreMemory } from "./retrieval.ts";
import { coerceMemoryEntry } from "./sanitize.ts";

const KEY = "memory.entries";
const DEFAULT_MAX_PERSISTENT = 500;
const MAX_NOTICES = 100;

/** Memory scope. `global` entries are visible from every workspace. */
export type MemoryScope = "workspace" | "global";

export type MemoryNoticeKind = "skipped" | "repaired" | "pruned" | "pruned-stated";

export interface MemoryNotice {
  at: string;
  kind: MemoryNoticeKind;
  reason: string;
  key?: string;
  id?: string;
}

export interface MemoryStoreOptions {
  /** Upper bound on persisted entries; pruning is always reported, never silent. */
  maxPersistentEntries?: number;
  onNotice?: (notice: MemoryNotice) => void;
}

export interface MemorySearchOptions {
  category?: MemoryCategory;
  workspaceId?: string;
  limit?: number;
  /** `all` reaches other workspaces too; the default keeps them out. */
  scope?: "workspace" | "all";
}

export class MemoryStore {
  private readonly storage: StorageAdapter;
  private sessionEntries: MemoryEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxPersistent: number;
  private readonly onNotice?: (notice: MemoryNotice) => void;
  private readonly noticeLog: MemoryNotice[] = [];
  private readonly seenLoadIssues = new Set<string>();

  constructor(storage: StorageAdapter, options?: MemoryStoreOptions) {
    this.storage = storage;
    this.maxPersistent = Math.max(1, options?.maxPersistentEntries ?? DEFAULT_MAX_PERSISTENT);
    this.onNotice = options?.onNotice;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private note(notice: Omit<MemoryNotice, "at">) {
    const full: MemoryNotice = { at: nowIso(), ...notice };
    this.noticeLog.push(full);
    if (this.noticeLog.length > MAX_NOTICES) this.noticeLog.splice(0, this.noticeLog.length - MAX_NOTICES);
    this.onNotice?.(full);
  }

  /**
   * Loading never throws. A record that cannot be repaired is dropped from this read
   * and reported once, so a single corrupt entry costs one memory rather than every
   * conversational turn that touches the store.
   */
  private async loadPersistent(): Promise<MemoryEntry[]> {
    let raw: JsonValue | undefined;
    try {
      raw = await this.storage.get(KEY);
    } catch (error) {
      this.noteOnce("storage-read", {
        kind: "skipped",
        reason: `memory could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.noteOnce("not-an-array", {
        kind: "skipped",
        reason: `stored memory is ${raw === null ? "null" : typeof raw}, not a list; starting empty`,
      });
      return [];
    }
    const entries: MemoryEntry[] = [];
    raw.forEach((item, index) => {
      const result = coerceMemoryEntry(item, "storage");
      if (!result.ok) {
        this.noteOnce(`skip:${index}:${result.reason}`, {
          kind: "skipped",
          reason: `entry ${index} is unusable (${result.reason})`,
        });
        return;
      }
      if (result.repaired.length) {
        this.noteOnce(`repair:${result.entry.key}:${result.repaired.join(",")}`, {
          kind: "repaired",
          reason: `filled in ${result.repaired.join(", ")}`,
          key: result.entry.key,
          id: result.entry.id,
        });
      }
      entries.push(result.entry);
    });
    return entries;
  }

  private noteOnce(signature: string, notice: Omit<MemoryNotice, "at">) {
    if (this.seenLoadIssues.has(signature)) return;
    this.seenLoadIssues.add(signature);
    this.note(notice);
  }

  private async savePersistent(entries: MemoryEntry[], keepId?: string) {
    await this.storage.set(KEY, this.prune(entries, keepId) as unknown as JsonValue);
  }

  private merged(persistent: MemoryEntry[]): MemoryEntry[] {
    return [...persistent, ...this.sessionEntries];
  }

  async remember(input: {
    category: MemoryCategory;
    key: string;
    value: string;
    workspaceId?: string;
    scope?: MemoryScope;
    source?: MemoryEntry["source"];
    tags?: string[];
    provenance?: MemoryEntry["provenance"];
  }): Promise<MemoryEntry> {
    return this.runExclusive(async () => {
      const now = nowIso();
      const session = input.category === "session";
      const workspaceId = input.scope === "global" ? undefined : input.workspaceId;
      const pool = session ? this.sessionEntries : await this.loadPersistent();
      const existing = pool.find(
        (entry) =>
          entry.key === input.key &&
          entry.category === input.category &&
          (entry.workspaceId ?? "") === (workspaceId ?? ""),
      );
      if (existing) {
        existing.value = input.value;
        existing.updatedAt = now;
        if (input.tags) existing.tags = input.tags;
        if (input.provenance) existing.provenance = input.provenance;
        if (!session) await this.savePersistent(pool, existing.id);
        return existing;
      }
      const entry: MemoryEntry = {
        id: createId("mem"),
        category: input.category,
        key: input.key,
        value: input.value,
        workspaceId,
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
      if (!session) await this.savePersistent(pool, entry.id);
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

  async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const entries = this.merged(await this.loadPersistent());
    const inScope = entries.filter((entry) => {
      if (options?.category && entry.category !== options.category) return false;
      if (options?.scope === "all") return true;
      if (options?.workspaceId && entry.workspaceId && entry.workspaceId !== options.workspaceId) {
        return false;
      }
      return true;
    });
    const prepared = prepareQuery(query, { workspaceId: options?.workspaceId });
    const ranked = prepared
      ? inScope
          .map((entry) => ({ entry, score: scoreMemory(entry, prepared) }))
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
          .map((row) => row.entry)
      : [...inScope].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return ranked.slice(0, options?.limit ?? 20);
  }

  /** Scores alongside the entries, for diagnostics and retrieval-quality tests. */
  async searchScored(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<{ entry: MemoryEntry; score: number }[]> {
    const prepared = prepareQuery(query, { workspaceId: options?.workspaceId });
    if (!prepared) return [];
    const hits = await this.search(query, options);
    return hits.map((entry) => ({ entry, score: scoreMemory(entry, prepared) }));
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
      await this.savePersistent(entries, entry.id);
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

  /** Capacity and integrity state, so a degraded store is visible rather than assumed. */
  async health(): Promise<{
    persistent: number;
    session: number;
    capacity: number;
    skipped: number;
    pruned: number;
  }> {
    const stats = await this.stats();
    return {
      ...stats,
      capacity: this.maxPersistent,
      skipped: this.noticeLog.filter((notice) => notice.kind === "skipped").length,
      pruned: this.noticeLog.filter((notice) => notice.kind === "pruned" || notice.kind === "pruned-stated")
        .length,
    };
  }

  notices(): MemoryNotice[] {
    return this.noticeLog.map((notice) => ({ ...notice }));
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
        const result = coerceMemoryEntry(item, "import");
        if (!result.ok) {
          skipped += 1;
          this.note({ kind: "skipped", reason: `import rejected an entry (${result.reason})` });
          continue;
        }
        valid.push(result.entry);
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

  /**
   * Keeps the persisted array bounded. Agent-inferred notes go first and a user-stated
   * fact is only ever dropped when nothing else can be — and never without a notice,
   * because losing something the user said is exactly the thing worth reporting.
   */
  private prune(entries: MemoryEntry[], keepId?: string): MemoryEntry[] {
    if (entries.length <= this.maxPersistent) return entries;
    const ordered = entries
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          evictionRank(a.entry) - evictionRank(b.entry) ||
          Date.parse(a.entry.updatedAt) - Date.parse(b.entry.updatedAt) ||
          a.index - b.index,
      );
    const doomed = new Set<string>();
    for (const row of ordered) {
      if (doomed.size >= entries.length - this.maxPersistent) break;
      if (row.entry.id === keepId) continue;
      doomed.add(row.entry.id);
      const stated = evictionRank(row.entry) === PROTECTED_RANK;
      this.note({
        kind: stated ? "pruned-stated" : "pruned",
        reason: stated
          ? `dropped a user-stated memory at capacity ${this.maxPersistent}`
          : `dropped the oldest ${row.entry.source}/${row.entry.provenance?.kind ?? "stated"} memory at capacity ${this.maxPersistent}`,
        key: row.entry.key,
        id: row.entry.id,
      });
    }
    return entries.filter((entry) => !doomed.has(entry.id));
  }
}

const PROTECTED_RANK = 3;

function evictionRank(entry: MemoryEntry): number {
  const kind = entry.provenance?.kind ?? "stated";
  if (entry.source === "user" && kind === "stated") return PROTECTED_RANK;
  if (entry.source === "user") return 2;
  if (entry.source === "system" || entry.source === "seed") return 1;
  return 0;
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
