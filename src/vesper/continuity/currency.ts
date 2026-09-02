/**
 * Current-state memory.
 *
 * A newer value does not erase the old one. Sarah works at Y is CURRENT; Sarah
 * works at X remains HISTORY, marked SUPERSEDED. Disagreement at the same generation
 * is DISPUTED rather than a silent overwrite.
 */

import { createId, nowIso } from "../id.ts";
import type { ContinuityTrust, MemoryCurrency } from "./types.ts";

export interface CurrentFact {
  id: string;
  subject: string;
  value: string;
  currency: MemoryCurrency;
  supersedes?: string;
  source: string;
  at: string;
  provenance: { trust: ContinuityTrust; deviceId: string };
  confidence: number;
}

export class CurrentStateStore {
  private facts = new Map<string, CurrentFact[]>();
  private readonly now: () => string;

  constructor(options?: { now?: () => string }) {
    this.now = options?.now ?? (() => new Date().toISOString());
  }

  remember(input: {
    subject: string;
    value: string;
    source: string;
    deviceId: string;
    trust?: ContinuityTrust;
    confidence?: number;
    at?: string;
  }): CurrentFact {
    const lineage = this.facts.get(input.subject) ?? [];
    const current = lineage.find((item) => item.currency === "current");
    const next: CurrentFact = {
      id: createId("fact"),
      subject: input.subject,
      value: input.value,
      currency: "current",
      source: input.source,
      at: input.at ?? this.now(),
      provenance: { trust: input.trust ?? "user", deviceId: input.deviceId },
      confidence: input.confidence ?? 1,
    };
    if (current) {
      if (current.value === input.value) return current;
      current.currency = "superseded";
      next.supersedes = current.id;
    }
    lineage.push(next);
    this.facts.set(input.subject, lineage);
    return next;
  }

  /**
   * A remote write of a different value at the same generation is a dispute.
   * History is kept. Neither side is discarded.
   */
  mergeRemote(fact: CurrentFact): { applied: CurrentFact; disputed: boolean } {
    const lineage = this.facts.get(fact.subject) ?? [];
    const current = lineage.find((item) => item.currency === "current");
    if (!current) {
      lineage.push({ ...fact, currency: "current" });
      this.facts.set(fact.subject, lineage);
      return { applied: fact, disputed: false };
    }
    if (current.value === fact.value) {
      return { applied: current, disputed: false };
    }
    const incomingAt = Date.parse(fact.at);
    const currentAt = Date.parse(current.at);
    if (incomingAt > currentAt) {
      current.currency = "superseded";
      const applied = { ...fact, currency: "current" as const, supersedes: current.id };
      lineage.push(applied);
      this.facts.set(fact.subject, lineage);
      return { applied, disputed: false };
    }
    if (incomingAt < currentAt) {
      lineage.push({ ...fact, currency: "superseded", supersedes: undefined });
      this.facts.set(fact.subject, lineage);
      return { applied: current, disputed: false };
    }
    current.currency = "disputed";
    const other = { ...fact, currency: "disputed" as const };
    lineage.push(other);
    this.facts.set(fact.subject, lineage);
    return { applied: current, disputed: true };
  }

  archive(subject: string): boolean {
    const lineage = this.facts.get(subject);
    if (!lineage) return false;
    for (const item of lineage) {
      if (item.currency === "current" || item.currency === "disputed") item.currency = "archived";
    }
    return true;
  }

  current(subject: string): CurrentFact | undefined {
    return this.facts.get(subject)?.find((item) => item.currency === "current");
  }

  history(subject: string): CurrentFact[] {
    return [...(this.facts.get(subject) ?? [])];
  }

  snapshot(): CurrentFact[] {
    return [...this.facts.values()].flat().map((item) => ({ ...item }));
  }
}

export function formatCurrent(fact: CurrentFact | undefined, history: CurrentFact[]): string {
  if (!fact && !history.length) return "unknown";
  const lines: string[] = [];
  if (fact) lines.push(`CURRENT: ${fact.subject} → ${fact.value}`);
  const superseded = history.filter((item) => item.currency === "superseded");
  for (const item of superseded) {
    lines.push(`HISTORY: ${item.subject} → ${item.value} (superseded)`);
  }
  const disputed = history.filter((item) => item.currency === "disputed");
  for (const item of disputed) {
    lines.push(`DISPUTED: ${item.subject} → ${item.value}`);
  }
  return lines.join("\n");
}
