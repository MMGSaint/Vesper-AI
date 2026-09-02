/**
 * Contradiction and revision.
 *
 * A new fact must not silently destroy a better one. Stated outranks observed,
 * observed outranks inferred. History is preserved as supersession, not deletion.
 */

import type { MemoryEntry } from "../types.ts";
import { classifyKind, provenanceRank } from "./kinds.ts";

export const REVISION_ACTIONS = ["keep", "supersede", "dispute", "reject"] as const;
export type RevisionAction = (typeof REVISION_ACTIONS)[number];

export interface RevisionDecision {
  action: RevisionAction;
  reason: string;
  keep: Pick<MemoryEntry, "key" | "value" | "provenance" | "updatedAt">;
  incoming: Pick<MemoryEntry, "key" | "value" | "provenance" | "updatedAt">;
}

export function reviseMemory(
  keep: Pick<MemoryEntry, "key" | "value" | "provenance" | "updatedAt" | "category" | "tags">,
  incoming: Pick<MemoryEntry, "key" | "value" | "provenance" | "updatedAt" | "category" | "tags">,
): RevisionDecision {
  if (keep.key !== incoming.key) {
    return { action: "keep", reason: "different keys are not a contradiction", keep, incoming };
  }
  if (keep.value === incoming.value) {
    return { action: "keep", reason: "same value; no revision", keep, incoming };
  }

  const keepRank = provenanceRank(keep.provenance?.kind);
  const incomingRank = provenanceRank(incoming.provenance?.kind);
  const keepTime = Date.parse(keep.updatedAt) || 0;
  const incomingTime = Date.parse(incoming.updatedAt) || 0;

  if (incomingRank < keepRank) {
    return {
      action: "reject",
      reason: `inferred or weaker evidence cannot overwrite ${keep.provenance?.kind ?? "existing"}`,
      keep,
      incoming,
    };
  }

  if (incomingRank > keepRank) {
    return {
      action: "supersede",
      reason: `${incoming.provenance?.kind ?? "incoming"} outranks ${keep.provenance?.kind ?? "existing"}`,
      keep,
      incoming,
    };
  }

  if (incomingTime > keepTime) {
    return {
      action: "supersede",
      reason: "newer information of equal provenance replaces the older",
      keep,
      incoming,
    };
  }

  if (incomingTime < keepTime) {
    return {
      action: "reject",
      reason: "older information cannot overwrite newer of equal provenance",
      keep,
      incoming,
    };
  }

  return {
    action: "dispute",
    reason: "equal provenance and time; both values are retained as disputed",
    keep,
    incoming,
  };
}

export function kindsConflict(
  a: Pick<MemoryEntry, "category" | "key" | "tags">,
  b: Pick<MemoryEntry, "category" | "key" | "tags">,
): boolean {
  return a.key === b.key && classifyKind(a) === classifyKind(b);
}
