/**
 * Smallest useful context.
 *
 * Retrieve the smallest set of facts that lets Vesper understand what the user
 * means. Stated preferences outrank inferred instincts. Instincts are labeled
 * as inferred so they cannot masquerade as facts.
 */

import type { MemoryEntry } from "../types.ts";
import { classifyKind, provenanceRank } from "./kinds.ts";
import type { Instinct } from "./instincts.ts";
import type { Procedure } from "../procedures.ts";

export interface AssembledFact {
  key: string;
  value: string;
  kind: string;
  provenance: "stated" | "observed" | "inferred";
  score: number;
}

export interface AssembledContext {
  facts: AssembledFact[];
  instincts: { situation: string; action: string; confidence: number; policy: false }[];
  procedures: { name: string; purpose: string }[];
  chars: number;
  dropped: number;
}

const SECRETISH = /(?:api[_-]?key|secret|password|token|credential|private[_-]?key)/i;

export function assembleContext(input: {
  query: string;
  memories: MemoryEntry[];
  instincts?: Instinct[];
  procedures?: Procedure[];
  budgetChars?: number;
}): AssembledContext {
  const budget = Math.min(Math.max(input.budgetChars ?? 1200, 200), 4000);
  const tokens = tokenize(input.query);
  const scored: AssembledFact[] = [];

  for (const entry of input.memories) {
    if (SECRETISH.test(entry.key) || SECRETISH.test(entry.value)) continue;
    if (entry.scope === "session") continue;
    const kind = classifyKind(entry);
    const provenance = entry.provenance?.kind ?? "inferred";
    let score = overlap(tokens, `${entry.key} ${entry.value} ${kind}`);
    score += provenanceRank(provenance) * 2;
    if (kind === "preference" || kind === "core") score += 4;
    if (kind === "project") score += 3;
    if (kind === "ephemeral") score -= 2;
    scored.push({
      key: entry.key,
      value: clip(entry.value, 180),
      kind,
      provenance,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const facts: AssembledFact[] = [];
  let chars = 0;
  let dropped = 0;
  for (const fact of scored) {
    const size = fact.key.length + fact.value.length + 8;
    if (chars + size > budget) {
      dropped += 1;
      continue;
    }
    facts.push(fact);
    chars += size;
    if (facts.length >= 8) {
      dropped += scored.length - facts.length;
      break;
    }
  }

  const instincts = (input.instincts ?? [])
    .filter((instinct) => instinct.state !== "observing" && instinct.state !== "decayed")
    .filter((instinct) => overlap(tokens, `${instinct.situation} ${instinct.action}`) > 0 || tokens.length === 0)
    .slice(0, 3)
    .map((instinct) => ({
      situation: instinct.situation,
      action: instinct.action,
      confidence: instinct.confidence,
      policy: false as const,
    }));

  const procedures = (input.procedures ?? [])
    .filter((procedure) => procedure.state === "active")
    .filter((procedure) => overlap(tokens, `${procedure.name} ${procedure.purpose}`) > 0 || tokens.length === 0)
    .slice(0, 2)
    .map((procedure) => ({ name: procedure.name, purpose: procedure.purpose }));

  return { facts, instincts, procedures, chars, dropped };
}

export function renderAssembled(ctx: AssembledContext): string {
  const lines = [
    ...ctx.facts.map((fact) => `- [${fact.kind}/${fact.provenance}] ${fact.key}: ${fact.value}`),
    ...ctx.instincts.map(
      (instinct) =>
        `- [instinct/inferred · not policy] when ${instinct.situation} tend to ${instinct.action} (confidence ${instinct.confidence.toFixed(2)})`,
    ),
    ...ctx.procedures.map((procedure) => `- [procedure/active] ${procedure.name}: ${procedure.purpose}`),
  ];
  return lines.join("\n");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 2);
}

function overlap(tokens: string[], hay: string): number {
  if (tokens.length === 0) return 1;
  const lower = hay.toLowerCase();
  return tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
