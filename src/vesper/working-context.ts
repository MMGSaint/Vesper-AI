/**
 * Bounded working context.
 *
 * Raw tool results belong in the audit trail. They do not belong, at full size, in
 * every later model turn. This module compresses older tool messages into a structured
 * fact: action, result, error, affected resources, identifiers, pending work, and the
 * provenance of the content.
 *
 * Compaction never upgrades trust. Tool output stays untrusted_external even when
 * summarised. The durable journal is not rewritten.
 */

import type { ChatMessage, ContextTrust, JsonValue } from "./types.ts";

export const MAX_WORKING_FACTS = 24;
export const MAX_FACT_CHARS = 400;
export const DEFAULT_KEEP_RECENT_TOOL_MESSAGES = 4;
export const DEFAULT_COMPACT_AFTER_CHARS = 800;

export interface CompactFact {
  action: string;
  result?: string;
  error?: string;
  affected: string[];
  identifiers: string[];
  pending?: string;
  unresolved?: string;
  trust: ContextTrust;
  at?: string;
  charsBefore: number;
}

export interface WorkingContext {
  facts: CompactFact[];
  dropped: number;
  chars: number;
}

const SECRETISH = /password|secret|token|credential|authorization|api[_-]?key/i;

export function compactWorkingContext(
  messages: ChatMessage[],
  options?: { keepRecentToolMessages?: number; compactAfterChars?: number; maxFacts?: number },
): { messages: ChatMessage[]; working: WorkingContext } {
  const keepRecent = options?.keepRecentToolMessages ?? DEFAULT_KEEP_RECENT_TOOL_MESSAGES;
  const compactAfter = options?.compactAfterChars ?? DEFAULT_COMPACT_AFTER_CHARS;
  const maxFacts = options?.maxFacts ?? MAX_WORKING_FACTS;

  const toolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") toolIndexes.push(index);
  });
  const keepFrom = toolIndexes.length <= keepRecent ? Number.POSITIVE_INFINITY : toolIndexes[toolIndexes.length - keepRecent];

  const facts: CompactFact[] = [];
  const next = messages.map((message, index) => {
    if (message.role !== "tool") return message;
    if (index >= keepFrom) return message;
    if (message.content.length <= compactAfter) return message;
    const fact = factFromToolMessage(message);
    facts.push(fact);
    return { ...message, content: formatFact(fact) };
  });

  const bounded = facts.slice(-maxFacts);
  const dropped = Math.max(0, facts.length - bounded.length);
  const chars = bounded.reduce((total, fact) => total + formatFact(fact).length, 0);
  return { messages: next, working: { facts: bounded, dropped, chars } };
}

export function factFromToolMessage(message: ChatMessage): CompactFact {
  const parsed = parseJson(message.content);
  const summary = pickString(parsed, "summary") || clip(message.content, 180);
  const ok = parsed && typeof parsed === "object" && "ok" in parsed ? Boolean((parsed as { ok?: unknown }).ok) : undefined;
  const epistemic = pickString(parsed, "epistemic");
  const trust: ContextTrust = "untrusted_external";
  const affected = collectAffected(parsed);
  const identifiers = collectIdentifiers(parsed);
  const pending = pickString(parsed, "confirmationId") || pickString(parsed, "pending");
  const error =
    ok === false ? summary : epistemic === "could_not_access" ? summary : undefined;
  return {
    action: message.name ? `tool ${message.name}` : "tool result",
    result: error ? undefined : summary,
    error,
    affected,
    identifiers,
    pending: pending || undefined,
    unresolved: error ? summary : undefined,
    trust,
    charsBefore: message.content.length,
  };
}

export function formatFact(fact: CompactFact): string {
  const parts = [
    `${fact.action}`,
    fact.result ? `result=${clip(fact.result, 160)}` : null,
    fact.error ? `error=${clip(fact.error, 160)}` : null,
    fact.affected.length ? `affected=${fact.affected.slice(0, 6).join(",")}` : null,
    fact.identifiers.length ? `ids=${fact.identifiers.slice(0, 6).join(",")}` : null,
    fact.pending ? `pending=${fact.pending}` : null,
    `trust=${fact.trust}`,
    `compacted_from=${fact.charsBefore}chars`,
  ];
  return clip(parts.filter(Boolean).join("; "), MAX_FACT_CHARS);
}

export function formatWorkingContext(working: WorkingContext): string {
  if (!working.facts.length) return "";
  const lines = working.facts.map((fact) => `- ${formatFact(fact)}`);
  if (working.dropped) lines.push(`- (${working.dropped} older compacted fact(s) omitted)`);
  return lines.join("\n");
}

/**
 * A compacted fact must not claim a higher trust than the source. Used by tests and
 * by anything that might later re-label summaries.
 */
export function retainTrust(from: ContextTrust, _summary: string): ContextTrust {
  return from;
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function pickString(value: JsonValue | undefined, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const found = value[key];
  return typeof found === "string" ? found : "";
}

function collectAffected(value: JsonValue | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: string[] = [];
  for (const key of ["path", "target", "name", "key", "toolName"]) {
    const found = value[key];
    if (typeof found === "string" && found && !SECRETISH.test(key)) out.push(found);
  }
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const path = data.path;
    if (typeof path === "string") out.push(path);
  }
  return [...new Set(out)].slice(0, 8);
}

function collectIdentifiers(value: JsonValue | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: string[] = [];
  for (const key of ["id", "confirmationId", "checkpointId", "taskId"]) {
    const found = value[key];
    if (typeof found === "string" && found) out.push(found);
  }
  return out.slice(0, 8);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15))}…(+${text.length - max}c)`;
}
