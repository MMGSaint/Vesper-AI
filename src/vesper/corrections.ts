/**
 * Correction records — what Vesper got wrong, and what the evidence actually said.
 *
 * The motivating shape, from the mission:
 *
 *   Vesper predicted a CPU optimization would help.
 *   NEXUS reported the workload was GPU-bound.
 *   The outcome showed no CPU benefit.
 *
 * That sequence is worth keeping, because it is the difference between an assistant
 * that repeats a wrong guess forever and one that can be shown to have learned. What is
 * NOT worth keeping — and is refused here — is the reasoning that produced the guess.
 * A correction is a small set of facts: what was believed, what was observed, what the
 * revised belief is, and who said so. No chain-of-thought.
 *
 * ## A correction is evidence, never authority
 *
 * This is the property the whole module is arranged around, because a learning signal
 * that can change policy is a policy edit with extra steps. A correction record:
 *
 *   - cannot grant a permission or relax one
 *   - cannot change a device's trust or un-revoke it
 *   - cannot alter the autonomy ceiling
 *   - cannot modify protected configuration
 *
 * Structurally, not by convention: this module imports nothing from `permissions.ts`,
 * `autonomy.ts`, `distributed/registry.ts` or `config.ts`, and the store's only write
 * target is its own storage key. There is no method here that takes a policy, a trust
 * state or a config object. `corrections-authority.test.ts` asserts the consequence
 * rather than the import list.
 *
 * ## Where the text comes from matters
 *
 * The `evidence` field is frequently a sentence a specialist produced — NEXUS reporting
 * what it measured. Under the project's rule that retrieved text is data and never
 * instruction, that string is sanitised on the way in. It is also screened for
 * credentials, because a correction is durable, is summarised back to the user, and is
 * one of the things a session capsule is designed to carry between devices.
 */

import { createId } from "./id.ts";
import { sanitiseInline } from "./untrusted.ts";
import { filterForSync } from "./distributed/sync.ts";
import type { StorageAdapter } from "./storage.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logging.ts";
import type { JsonObject, JsonValue, MemoryEntry } from "./types.ts";

const STORAGE_KEY = "corrections.records";
const DEFAULT_MAX_RETAINED = 200;
/** Per-field cap. Corrections are summaries; a long one is a transcript by another name. */
const MAX_FIELD_CHARS = 400;

/**
 * Which part of the system was wrong.
 *
 * A closed list, so a correction cannot be filed against a subsystem that does not
 * exist and quietly never be read.
 */
export const CORRECTION_SUBSYSTEMS = [
  "optimizer",
  "model",
  "scheduler",
  "hardware",
  "knowledge",
  "memory",
  "runtime",
] as const;
export type CorrectionSubsystem = (typeof CORRECTION_SUBSYSTEMS)[number];

/**
 * What the evidence settled.
 *
 * `assumption_held` is deliberately a recordable outcome: an expectation that survived
 * contact with evidence is a result, and a store that only ever admits failures gives a
 * badly skewed picture of how often Vesper is right. `inconclusive` exists so that "we
 * looked and could not tell" never has to be rounded to one of the other two.
 */
export const CORRECTION_OUTCOMES = ["assumption_wrong", "assumption_held", "inconclusive"] as const;
export type CorrectionOutcome = (typeof CORRECTION_OUTCOMES)[number];

/** Who produced the evidence. Provenance is recorded, never inferred from content. */
export interface CorrectionSource {
  /** "specialist" is an external system such as NEXUS; "subsystem" is Vesper itself. */
  author: "specialist" | "subsystem" | "user";
  /** Which one — an adapter id, a module name, or "user". */
  origin: string;
  /**
   * Whether the evidence came from a component Vesper controls.
   *
   * Recorded so a reader can weigh the record. It confers nothing: an untrusted source's
   * correction is stored the same way, sanitised the same way, and grants exactly as
   * much authority as a trusted one, which is none.
   */
  external: boolean;
}

export interface CorrectionRecord {
  id: string;
  at: string;
  subsystem: CorrectionSubsystem;
  /** What was happening when the expectation was formed. */
  context: string;
  /** What Vesper expected or predicted. */
  assumption: string;
  /** The observation that bore on it. Sanitised — this is often specialist text. */
  evidence: string;
  /** The revised belief, in one sentence. */
  correction: string;
  outcome: CorrectionOutcome;
  source: CorrectionSource;
  correlationId?: string;
  sessionId?: string;
}

export interface CorrectionInput {
  subsystem: CorrectionSubsystem;
  context: string;
  assumption: string;
  evidence: string;
  correction: string;
  outcome: CorrectionOutcome;
  source: CorrectionSource;
  correlationId?: string;
  sessionId?: string;
}

export interface CorrectionStoreOptions {
  storage: StorageAdapter;
  log: Logger;
  events?: EventBus;
  maxRetained?: number;
  now?: () => Date;
}

/** Reject a field that looks like a credential, using the same filter sync uses. */
function looksLikeSecret(text: string): boolean {
  const probe: MemoryEntry = {
    id: "screen",
    category: "fact",
    key: "screen",
    value: text,
    createdAt: "1970-01-01T00:00:00Z",
    updatedAt: "1970-01-01T00:00:00Z",
    source: "agent",
    scope: "user",
    revision: 1,
  };
  return filterForSync([probe]).send.length === 0;
}

export class CorrectionStore {
  private readonly storage: StorageAdapter;
  private readonly log: Logger;
  private readonly events: EventBus | undefined;
  private readonly maxRetained: number;
  private readonly clock: () => Date;
  private records: CorrectionRecord[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(opts: CorrectionStoreOptions) {
    this.storage = opts.storage;
    this.log = opts.log;
    this.events = opts.events;
    this.maxRetained = Math.max(10, Math.min(2000, Math.floor(opts.maxRetained ?? DEFAULT_MAX_RETAINED)));
    this.clock = opts.now ?? (() => new Date());
  }

  /**
   * File a correction.
   *
   * Returns the stored record, or a refusal. Refusing is not an error path to be
   * swallowed: a correction whose evidence is a leaked credential must not be written,
   * and a caller that ignores the reason ships the leak into a durable store that a
   * capsule is designed to carry off-device.
   */
  async record(
    input: CorrectionInput,
  ): Promise<{ ok: true; record: CorrectionRecord } | { ok: false; reason: string }> {
    if (!CORRECTION_SUBSYSTEMS.includes(input.subsystem)) {
      return { ok: false, reason: `Unknown subsystem '${input.subsystem}'.` };
    }
    if (!CORRECTION_OUTCOMES.includes(input.outcome)) {
      return { ok: false, reason: `Unknown outcome '${input.outcome}'.` };
    }
    for (const [name, value] of [
      ["context", input.context],
      ["assumption", input.assumption],
      ["evidence", input.evidence],
      ["correction", input.correction],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, reason: `A correction needs a non-empty '${name}'.` };
      }
      if (looksLikeSecret(value)) {
        return { ok: false, reason: `'${name}' looks like a credential; refused.` };
      }
    }

    await this.load();
    // Every free-text field is sanitised, not just the external one. The rule is that
    // retrieved text is data rather than instruction, and screening is evidence while
    // the escaping is what actually contains an attack — so it applies to clean content
    // too, and applying it only to fields we think are risky is how one gets missed.
    const record: CorrectionRecord = {
      id: createId("cor"),
      at: this.clock().toISOString(),
      subsystem: input.subsystem,
      context: sanitiseInline(input.context, MAX_FIELD_CHARS),
      assumption: sanitiseInline(input.assumption, MAX_FIELD_CHARS),
      evidence: sanitiseInline(input.evidence, MAX_FIELD_CHARS),
      correction: sanitiseInline(input.correction, MAX_FIELD_CHARS),
      outcome: input.outcome,
      source: {
        author: input.source.author,
        origin: sanitiseInline(input.source.origin, 80),
        external: !!input.source.external,
      },
      correlationId: input.correlationId,
      sessionId: input.sessionId,
    };
    this.records.push(record);
    this.trim();
    this.schedulePersist();

    this.events?.emit({
      type: "correction.recorded",
      title: `Correction for ${record.subsystem}: ${record.outcome}`,
      detail: record.correction,
      severity: "info",
      correlationId: record.correlationId,
      // Durable by design. A correction that is aged out of the hot ring before anyone
      // reads it is a learning signal nobody learned from.
      retention: "durable",
      provenance: { author: "subsystem", source: "corrections" },
      data: {
        correctionId: record.id,
        subsystem: record.subsystem,
        outcome: record.outcome,
        sourceAuthor: record.source.author,
        sourceOrigin: record.source.origin,
        external: record.source.external,
      } as JsonObject,
    });

    return { ok: true, record: { ...record } };
  }

  /** Most recent last. */
  async list(filter?: {
    limit?: number;
    subsystem?: CorrectionSubsystem;
    outcome?: CorrectionOutcome;
    since?: string;
  }): Promise<CorrectionRecord[]> {
    await this.load();
    let out = this.records.slice();
    if (filter?.subsystem) out = out.filter((r) => r.subsystem === filter.subsystem);
    if (filter?.outcome) out = out.filter((r) => r.outcome === filter.outcome);
    if (filter?.since) {
      const cutoff = new Date(filter.since).getTime();
      if (!Number.isNaN(cutoff)) out = out.filter((r) => new Date(r.at).getTime() >= cutoff);
    }
    const limit = Math.max(1, Math.min(200, Math.floor(filter?.limit ?? 20)));
    return out.slice(-limit).map((r) => ({ ...r }));
  }

  /** Counts by outcome, for a summary that does not have to read every record. */
  async tally(): Promise<Record<CorrectionOutcome, number>> {
    await this.load();
    const out: Record<CorrectionOutcome, number> = {
      assumption_wrong: 0,
      assumption_held: 0,
      inconclusive: 0,
    };
    for (const record of this.records) out[record.outcome] += 1;
    return out;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadOnce().finally(() => {
      this.loaded = true;
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async loadOnce(): Promise<void> {
    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (!Array.isArray(raw)) return;
      const restored: CorrectionRecord[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const c = item as Partial<CorrectionRecord>;
        // Validate on the way OUT, not only on the way in. The blob lives in the shared
        // state file; a corrupted or planted entry must not become a record with a
        // subsystem nothing recognises or an outcome that skews every tally.
        if (typeof c.id !== "string" || typeof c.at !== "string") continue;
        if (!CORRECTION_SUBSYSTEMS.includes(c.subsystem as CorrectionSubsystem)) continue;
        if (!CORRECTION_OUTCOMES.includes(c.outcome as CorrectionOutcome)) continue;
        if (
          typeof c.context !== "string" ||
          typeof c.assumption !== "string" ||
          typeof c.evidence !== "string" ||
          typeof c.correction !== "string"
        ) {
          continue;
        }
        const source = c.source as Partial<CorrectionSource> | undefined;
        restored.push({
          id: c.id,
          at: Number.isNaN(new Date(c.at).getTime()) ? this.clock().toISOString() : c.at,
          subsystem: c.subsystem as CorrectionSubsystem,
          context: sanitiseInline(c.context, MAX_FIELD_CHARS),
          assumption: sanitiseInline(c.assumption, MAX_FIELD_CHARS),
          evidence: sanitiseInline(c.evidence, MAX_FIELD_CHARS),
          correction: sanitiseInline(c.correction, MAX_FIELD_CHARS),
          outcome: c.outcome as CorrectionOutcome,
          source: {
            author:
              source?.author === "specialist" || source?.author === "user" ? source.author : "subsystem",
            origin: typeof source?.origin === "string" ? sanitiseInline(source.origin, 80) : "unknown",
            external: !!source?.external,
          },
          correlationId: typeof c.correlationId === "string" ? c.correlationId : undefined,
          sessionId: typeof c.sessionId === "string" ? c.sessionId : undefined,
        });
      }
      this.records = restored;
      this.trim();
    } catch (error) {
      // A corrupt blob costs the history, never availability.
      this.log.warn("memory", "Could not load corrections; starting empty", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.records = [];
    }
  }

  private trim(): void {
    if (this.records.length > this.maxRetained) {
      this.records.splice(0, this.records.length - this.maxRetained);
    }
  }

  private schedulePersist(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving
      .then(async () => {
        this.saveQueued = false;
        await this.storage.set(STORAGE_KEY, this.records as unknown as JsonValue);
      })
      .catch((error: unknown) => {
        this.saveQueued = false;
        this.log.warn("memory", "Could not persist corrections", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
