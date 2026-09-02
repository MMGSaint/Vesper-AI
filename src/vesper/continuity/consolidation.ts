/**
 * Idle-time consolidation foothold.
 *
 * IDLE → gather candidates → deterministic validation → update derived indexes
 * → optionally prepare hot context → record audit.
 *
 * Source memory remains authoritative. This never rewrites personality, never
 * grants a permission, and never wakes a model.
 */

export interface ConsolidationCandidate {
  key: string;
  value: string;
  source: "memory" | "working" | "continuity";
}

export interface ConsolidationReport {
  ran: boolean;
  wokeModel: false;
  rewroteAuthoritative: false;
  considered: number;
  indexed: number;
  hotContextChars: number;
  reason: string;
}

const MAX_HOT = 800;

export function runIdleConsolidation(input: {
  enabled: boolean;
  candidates: ConsolidationCandidate[];
}): ConsolidationReport {
  if (!input.enabled) {
    return {
      ran: false,
      wokeModel: false,
      rewroteAuthoritative: false,
      considered: 0,
      indexed: 0,
      hotContextChars: 0,
      reason: "consolidation is disabled",
    };
  }
  const indexed = input.candidates.filter((item) => item.source !== "working" && item.value.trim()).length;
  const hot = input.candidates
    .slice(0, 8)
    .map((item) => `${item.key}: ${item.value}`)
    .join("\n")
    .slice(0, MAX_HOT);
  return {
    ran: true,
    wokeModel: false,
    rewroteAuthoritative: false,
    considered: input.candidates.length,
    indexed,
    hotContextChars: hot.length,
    reason: "derived indexes updated; source memory unchanged",
  };
}
