/**
 * Inspectable projection of persistent memory.
 *
 * OpenHuman's useful idea is not SQLite or an Obsidian vault. It is that memory is a
 * *readable document* grouped by kind, not a vector soup the owner cannot audit.
 * This is a projection of the existing store. It is not a second source of truth,
 * does not write back, and does not invent categories.
 *
 * Session memory is never exported (exportPersistent already excludes it).
 * Values whose keys look like secrets are summarised by length, not quoted.
 */

import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry, type MemoryScopeLevel } from "../types.ts";

const SECRETISH = /password|secret|token|credential|authorization|api[_-]?key/i;

const CATEGORY_HEADING: Record<MemoryCategory, string> = {
  preference: "Preferences",
  fact: "Facts",
  project: "Projects",
  workflow: "Workflows",
  routine: "Routines",
  task: "Tasks",
  config: "Config",
  context: "Context",
  session: "Session",
};

export function formatMemoryWiki(entries: readonly MemoryEntry[], exportedAt?: string): string {
  const lines: string[] = [
    "# Vesper memory",
    "",
    "A readable projection of persistent memory. The JSON export next to this file is the",
    "authoritative copy. Editing this markdown does not change what Vesper remembers.",
    "",
  ];
  if (exportedAt) {
    lines.push(`Exported: ${exportedAt}`, "");
  }
  lines.push(`${entries.length} persistent ${entries.length === 1 ? "entry" : "entries"}.`, "");

  const byCategory = new Map<MemoryCategory, MemoryEntry[]>();
  for (const category of MEMORY_CATEGORIES) byCategory.set(category, []);
  for (const entry of entries) {
    const list = byCategory.get(entry.category);
    if (list) list.push(entry);
  }

  let wrote = false;
  for (const category of MEMORY_CATEGORIES) {
    const list = byCategory.get(category) ?? [];
    if (list.length === 0) continue;
    wrote = true;
    lines.push(`## ${CATEGORY_HEADING[category]}`, "");
    const byScope = groupByScope(list);
    for (const [scope, scoped] of byScope) {
      if (byScope.length > 1) lines.push(`### ${scope}`, "");
      for (const entry of scoped) {
        lines.push(`- **${escapeBreak(entry.key)}** (${originLabel(entry)}): ${displayValue(entry)}`);
      }
      lines.push("");
    }
  }
  if (!wrote) {
    lines.push("_No persistent memories._", "");
  }
  return lines.join("\n");
}

function groupByScope(entries: MemoryEntry[]): Array<[MemoryScopeLevel, MemoryEntry[]]> {
  const order: MemoryScopeLevel[] = ["user", "workspace", "device", "global", "session"];
  const map = new Map<MemoryScopeLevel, MemoryEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.scope) ?? [];
    list.push(entry);
    map.set(entry.scope, list);
  }
  return order.filter((scope) => map.has(scope)).map((scope) => [scope, map.get(scope)!]);
}

function originLabel(entry: MemoryEntry): string {
  const kind = entry.provenance?.kind ?? "stated";
  const source = entry.source ?? "user";
  if (source === "user" && kind === "stated") return "stated";
  if (kind === "inferred") return "inferred";
  return source;
}

function displayValue(entry: MemoryEntry): string {
  if (SECRETISH.test(entry.key)) {
    return `[redacted ${entry.value.length} characters]`;
  }
  return escapeBreak(entry.value);
}

function escapeBreak(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}
