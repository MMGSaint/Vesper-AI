/**
 * Why Vesper did something — the governor's decision journal, queryable.
 *
 * Catch-up already *counts* autonomy.decision / autonomy.no_action events. That answers
 * "how many times did Vesper act while I was away". It does not answer "why did it
 * refuse fs_write on this turn" or "what did the governor decide about this
 * correlation id". Those are the questions this module exists for.
 *
 * Three honest claims, never collapsed:
 *
 *   vouched     — this process's governor emitted the record (session nonce matches).
 *   recorded    — the journal or the ring holds it; this process cannot re-verify.
 *                 Previous-session entries land here because the nonce does not
 *                 survive a restart, which is what the governor's own docs say.
 *   unauthenticated — on the live bus, carrying a governorNonce that is not ours.
 *                 A forged autonomy.decision. Shown so loss is loud, never counted
 *                 as "Vesper allowed X".
 *
 * This module is evidence, never authority. Reading a decision cannot grant a
 * permission, relax one, change trust, or move the autonomy ceiling.
 */

import { sanitiseInline } from "./untrusted.ts";
import type { AutonomyGovernor } from "./autonomy.ts";
import type { EventBus } from "./events.ts";
import type { EventJournal } from "./event-journal.ts";
import type { JsonObject, VesperEvent } from "./types.ts";

export const DECISION_EVENT_TYPES = ["autonomy.decision", "autonomy.no_action"] as const;

export type DecisionEventType = (typeof DECISION_EVENT_TYPES)[number];

export type DecisionAuthenticity = "vouched" | "recorded" | "unauthenticated";

export interface DecisionRecord {
  id: string;
  at: string;
  type: DecisionEventType;
  title: string;
  detail: string;
  tool: string | null;
  governorLevel: string | null;
  allowed: boolean | null;
  tightened: boolean | null;
  originKind: string | null;
  correlationId: string | null;
  authenticity: DecisionAuthenticity;
}

export interface DecisionQuery {
  correlationId?: string;
  limit?: number;
}

export interface DecisionReport {
  records: DecisionRecord[];
  /** How many of `records` this process can actually vouch for. */
  vouched: number;
  recorded: number;
  unauthenticated: number;
  /**
   * Where the rows came from. `journal` means at least one row survived a restart;
   * `ring` means we only still have what is in this process; `none` is an empty report.
   */
  source: "journal" | "ring" | "none";
  /** Oldest timestamp still visible, or null when there is nothing to show. */
  horizon: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function isDecisionType(type: string): type is DecisionEventType {
  return type === "autonomy.decision" || type === "autonomy.no_action";
}

function strField(data: JsonObject | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolField(data: JsonObject | undefined, key: string): boolean | null {
  const value = data?.[key];
  return typeof value === "boolean" ? value : null;
}

function authenticityOf(
  event: VesperEvent,
  governor: AutonomyGovernor | undefined,
): DecisionAuthenticity {
  if (!governor) return "recorded";
  if (governor.isAuthentic(event)) return "vouched";
  // A nonce that is present and wrong is a live-bus forgery. A nonce that is absent
  // is a record from before this process (or from a writer that never stamped one).
  const nonce = event.data?.["governorNonce"];
  if (typeof nonce === "string" && nonce.length > 0) return "unauthenticated";
  return "recorded";
}

export function projectDecision(
  event: VesperEvent,
  governor: AutonomyGovernor | undefined,
): DecisionRecord | null {
  if (!isDecisionType(event.type)) return null;
  return {
    id: event.id,
    at: event.at,
    type: event.type,
    title: sanitiseInline(event.title, 160),
    detail: sanitiseInline(event.detail ?? "", 280),
    tool: strField(event.data, "tool"),
    governorLevel: strField(event.data, "governorLevel"),
    allowed: boolField(event.data, "governorAllowed"),
    tightened: boolField(event.data, "tightened"),
    originKind: strField(event.data, "originKind"),
    correlationId: event.correlationId ?? null,
    authenticity: authenticityOf(event, governor),
  };
}

/**
 * Collect governor decisions from the durable journal, falling back to the hot ring
 * when the journal is empty or not attached. Dedupes by event id so a just-emitted
 * decision that is still in the pending journal queue is not listed twice.
 */
export async function collectDecisions(input: {
  events: EventBus;
  journal?: EventJournal;
  governor?: AutonomyGovernor;
  query?: DecisionQuery;
}): Promise<DecisionReport> {
  const limitRaw = input.query?.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limitRaw) || DEFAULT_LIMIT)));
  const correlationId =
    typeof input.query?.correlationId === "string" && input.query.correlationId.length > 0
      ? input.query.correlationId
      : undefined;

  const byId = new Map<string, VesperEvent>();
  let usedJournal = false;

  if (input.journal) {
    try {
      const durable = await input.journal.query({
        types: [...DECISION_EVENT_TYPES],
        correlationId,
        // Ask for more than we will keep so a flood of unauthenticated rows cannot
        // starve the vouched ones out of a small limit before we classify.
        limit: MAX_LIMIT,
      });
      for (const event of durable) byId.set(event.id, event);
      usedJournal = durable.length > 0;
    } catch {
      // A refused filter or a corrupt partition must not take the diagnostic down.
      // The ring is the remaining source.
    }
  }

  for (const event of input.events.all()) {
    if (!isDecisionType(event.type)) continue;
    if (correlationId && event.correlationId !== correlationId) continue;
    if (!byId.has(event.id)) byId.set(event.id, event);
  }

  const projected = [...byId.values()]
    .map((event) => projectDecision(event, input.governor))
    .filter((row): row is DecisionRecord => row !== null)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const records = projected.slice(0, limit);
  let vouched = 0;
  let recorded = 0;
  let unauthenticated = 0;
  for (const row of records) {
    if (row.authenticity === "vouched") vouched += 1;
    else if (row.authenticity === "unauthenticated") unauthenticated += 1;
    else recorded += 1;
  }

  const horizon = records.length > 0 ? records[records.length - 1]!.at : null;
  const source: DecisionReport["source"] =
    records.length === 0 ? "none" : usedJournal ? "journal" : "ring";

  return { records, vouched, recorded, unauthenticated, source, horizon };
}

/**
 * A plain-text report for `--decisions` and the tool summary. Every line is a fact
 * about a record we hold, never a reconstruction of the reasoning that produced it.
 */
export function formatDecisions(report: DecisionReport): string {
  if (report.records.length === 0) {
    return "No autonomy decisions are on record in this process.";
  }

  const lines: string[] = [];
  const counts: string[] = [];
  if (report.vouched) counts.push(`${report.vouched} vouched this session`);
  if (report.recorded) counts.push(`${report.recorded} recorded (cannot re-verify)`);
  if (report.unauthenticated) counts.push(`${report.unauthenticated} unauthenticated, not counted as Vesper's`);
  lines.push(`Autonomy decisions (${report.records.length}): ${counts.join("; ")}.`);
  lines.push(
    report.source === "journal"
      ? "Source: durable journal."
      : "Source: in-memory ring only — these will not survive a restart.",
  );
  if (report.horizon) lines.push(`Oldest row still shown: ${report.horizon}.`);

  for (const row of report.records) {
    const tag =
      row.authenticity === "vouched"
        ? "vouched"
        : row.authenticity === "unauthenticated"
          ? "UNAUTHENTICATED"
          : "recorded";
    const tool = row.tool ? ` ${row.tool}` : "";
    const level = row.governorLevel ? ` [${row.governorLevel}]` : "";
    const corr = row.correlationId ? ` corr=${row.correlationId}` : "";
    lines.push(`- [${tag}] ${row.at}${tool}${level} ${row.title}${corr}`);
    if (row.detail) lines.push(`    ${row.detail}`);
  }
  return lines.join("\n");
}
