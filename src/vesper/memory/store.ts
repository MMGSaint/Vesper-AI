import { createId, nowIso } from "../id.ts";
import type { StorageAdapter } from "../storage.ts";
import type { JsonValue, MemoryCategory, MemoryEntry } from "../types.ts";

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
  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private async load(): Promise<MemoryEntry[]> {
    return asEntries(await this.storage.get(KEY));
  }

  private async save(entries: MemoryEntry[]) {
    await this.storage.set(KEY, entries as unknown as JsonValue);
  }

  async remember(input: {
    category: MemoryCategory;
    key: string;
    value: string;
    workspaceId?: string;
    source?: MemoryEntry["source"];
    tags?: string[];
  }): Promise<MemoryEntry> {
    const entries = await this.load();
    const existing = entries.find(
      (entry) =>
        entry.key === input.key &&
        entry.category === input.category &&
        (entry.workspaceId ?? "") === (input.workspaceId ?? ""),
    );
    const now = nowIso();
    if (existing) {
      existing.value = input.value;
      existing.updatedAt = now;
      if (input.tags) existing.tags = input.tags;
      await this.save(entries);
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
    };
    entries.push(entry);
    await this.save(entries);
    return entry;
  }

  async retrieve(idOrKey: string, workspaceId?: string): Promise<MemoryEntry | undefined> {
    const entries = await this.load();
    return entries.find(
      (entry) =>
        (entry.id === idOrKey || entry.key === idOrKey) &&
        (workspaceId ? entry.workspaceId === workspaceId || !entry.workspaceId : true),
    );
  }

  async search(query: string, options?: { category?: MemoryCategory; workspaceId?: string; limit?: number }) {
    const entries = await this.load();
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
    const entries = await this.load();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return undefined;
    if (patch.value !== undefined) entry.value = patch.value;
    if (patch.tags !== undefined) entry.tags = patch.tags;
    if (patch.category !== undefined) entry.category = patch.category;
    if (patch.key !== undefined) entry.key = patch.key;
    entry.updatedAt = nowIso();
    await this.save(entries);
    return entry;
  }

  async forget(idOrKey: string): Promise<boolean> {
    const entries = await this.load();
    const next = entries.filter((entry) => entry.id !== idOrKey && entry.key !== idOrKey);
    if (next.length === entries.length) return false;
    await this.save(next);
    return true;
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
    return this.load();
  }
}
