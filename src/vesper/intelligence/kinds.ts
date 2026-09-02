/**
 * Differentiated memory kinds.
 *
 * Existing `MemoryCategory` is how a fact was filed. Kind is what the fact *is*
 * for the personal intelligence layer: identity, preference, episode, procedure,
 * and so on. Classification is derived from category + tags so persistence does
 * not have to change. Promotion from ephemeral to vault is never automatic.
 */

import type { MemoryCategory, MemoryEntry } from "../types.ts";

export const MEMORY_KINDS = [
  "core",
  "preference",
  "semantic",
  "episodic",
  "procedural",
  "project",
  "resource",
  "vault",
  "ephemeral",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const CATEGORY_TO_KIND: Record<MemoryCategory, MemoryKind> = {
  preference: "preference",
  fact: "semantic",
  project: "project",
  workflow: "procedural",
  routine: "procedural",
  task: "episodic",
  config: "core",
  context: "ephemeral",
  session: "ephemeral",
};

export const PROVENANCE_RANK = { stated: 3, observed: 2, inferred: 1 } as const;

export function classifyKind(
  entry: Pick<MemoryEntry, "category" | "key" | "tags">,
): MemoryKind {
  const tags = (entry.tags ?? []).map((tag) => tag.toLowerCase());
  if (tags.includes("vault") || tags.includes("knowledge-vault")) return "vault";
  if (tags.includes("core") || tags.includes("identity")) return "core";
  if (tags.includes("resource") || /^https?:\/\//i.test(entry.key)) return "resource";
  if (tags.includes("ephemeral") || tags.includes("tmp")) return "ephemeral";
  return CATEGORY_TO_KIND[entry.category] ?? "semantic";
}

export function kindPrivacyDefault(kind: MemoryKind): "private" | "device_only" | "shared" | "global" {
  if (kind === "core" || kind === "preference" || kind === "vault") return "private";
  if (kind === "ephemeral") return "private";
  if (kind === "project" || kind === "procedural") return "shared";
  return "shared";
}

/**
 * Vault is deliberate long-term retention. Ephemeral and session facts cannot
 * become vault without an explicit confirmation step outside this function.
 */
export function mayAutoPromote(from: MemoryKind, to: MemoryKind): boolean {
  if (to === "vault") return false;
  if (from === "ephemeral" && to !== "ephemeral") return false;
  return true;
}

export function provenanceRank(kind: "stated" | "observed" | "inferred" | undefined): number {
  if (!kind) return PROVENANCE_RANK.inferred;
  return PROVENANCE_RANK[kind];
}

export function formatKindLabel(entry: Pick<MemoryEntry, "category" | "key" | "tags" | "provenance">): string {
  const kind = classifyKind(entry);
  const provenance = entry.provenance?.kind ?? "inferred";
  return `${kind}/${provenance}`;
}
