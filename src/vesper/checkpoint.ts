/**
 * CheckpointStore — deterministic pre-image capture and Vesper-owned rollback.
 *
 * The mission's rule: some Vesper-driven changes should be reversible with a
 * deterministic record of what changed. Not every change on the machine — only
 * changes Vesper made, to Vesper-owned state, with a snapshot recorded before the
 * write. A model-generated statement that something is reversible is not sufficient;
 * the pre-image is the evidence.
 *
 * The pattern every reversible operation follows:
 *   PLAN
 *   → CHECKPOINT (snapshot before, get an id)
 *   → APPLY (run the change)
 *   → VERIFY (record the post-state)
 *   → KEEP OR ROLLBACK (later, when a user or a governor decides)
 *
 * Store shape:
 *   - Single storage key `rollback.checkpoints` (a single blob; capped)
 *   - Each entry: {id, tool, target, before, after?, at, workspaceId, correlationId, ttlMs}
 *   - `before` is JsonValue-compatible — a string, an object, or null (meaning "no
 *     previous value")
 *   - Retention: max 100 entries, oldest first out; each entry has its own TTL
 *
 * Non-goals:
 *   - Not a universal rollback engine for every Windows operation (the mission is
 *     explicit about this).
 *   - Not a backup layer — checkpoints are short-lived recovery state around a change.
 *     A longer-lived backup is a separate concept the mission distinguishes and this
 *     module does not conflate them.
 *   - Not the NEXUS-side optimizer rollback (`optimizer.requestRollback` at
 *     specialists/optimizer.ts:25). That reverses the external optimizer's changes,
 *     not Vesper's.
 *
 * Load-bearing invariants:
 *   - A checkpoint captured with `snapshot` must have a `before` value at the moment
 *     of capture, even if that value is "did not exist" (recorded as null with a
 *     `before === null` and `absentBefore: true`).
 *   - `rollback` verifies the current value against the recorded `after` before it
 *     reverses. If the current value has moved on beyond the recorded change, the
 *     rollback refuses — this prevents silently overwriting a later user action.
 *   - A rollback record cannot claim to have reversed a change it did not; every
 *     rollback path emits an event whose `data.applied` flag is only true when the
 *     reversal actually ran.
 */

import { createId, nowIso } from "./id.ts";
import type { StorageAdapter } from "./storage.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logging.ts";
import type { JsonObject, JsonValue } from "./types.ts";

const STORAGE_KEY = "rollback.checkpoints";
const DEFAULT_MAX_RETAINED = 100;
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;

export interface CheckpointRecord {
  id: string;
  /** Which tool / subsystem produced the change (e.g. "memory_remember"). */
  tool: string;
  /** The target of the change — a memory key, a workspace id, a file path. */
  target: string;
  /** Pre-image, JSON-serialisable. `null` with absentBefore=true means "did not exist". */
  before: JsonValue | null;
  absentBefore: boolean;
  /** Post-image, filled in by verify() once the write completes. Optional. */
  after?: JsonValue | null;
  at: string;
  workspaceId?: string;
  correlationId?: string;
  ttlMs: number;
  /** Set by rollback(); prevents re-application. */
  rolledBackAt?: string;
}

export interface Reverser {
  /**
   * Return true if the current state still matches the recorded `after` (or the
   * checkpoint has no recorded after). Return false if the state has moved on and
   * the rollback should refuse.
   */
  verify(record: CheckpointRecord): Promise<boolean>;
  /**
   * Restore the pre-image. Must throw on failure; a returned promise that resolves
   * counts as success and the record is marked rolledBackAt.
   */
  restore(record: CheckpointRecord): Promise<void>;
}

export interface CheckpointStoreOptions {
  storage: StorageAdapter;
  log: Logger;
  events?: EventBus;
  maxRetained?: number;
  now?: () => Date;
}

export class CheckpointStore {
  private readonly storage: StorageAdapter;
  private readonly log: Logger;
  private readonly events: EventBus | undefined;
  private readonly maxRetained: number;
  private readonly clock: () => Date;
  private records: CheckpointRecord[] = [];
  private reversers = new Map<string, Reverser>();
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(opts: CheckpointStoreOptions) {
    this.storage = opts.storage;
    this.log = opts.log;
    this.events = opts.events;
    this.maxRetained = Math.max(10, Math.floor(opts.maxRetained ?? DEFAULT_MAX_RETAINED));
    this.clock = opts.now ?? (() => new Date());
  }

  /**
   * Register a reverser for a tool. Only one per tool — a second register throws to
   * catch double-wire bugs. Reversers are separate from records so the runtime can
   * install its integrations once, and tests can substitute mocks.
   */
  registerReverser(tool: string, reverser: Reverser): void {
    if (this.reversers.has(tool)) {
      throw new Error(`Checkpoint reverser already registered for tool: ${tool}`);
    }
    this.reversers.set(tool, reverser);
  }

  /**
   * Snapshot the pre-image. The caller then runs the write; verify() is called after
   * with the post-image. A snapshot without a follow-up verify still records the
   * pre-image — a rollback can still restore, but there is no drift check.
   */
  async snapshot(input: {
    tool: string;
    target: string;
    before: JsonValue | null;
    absentBefore?: boolean;
    workspaceId?: string;
    correlationId?: string;
    ttlMs?: number;
  }): Promise<CheckpointRecord> {
    await this.load();
    const record: CheckpointRecord = {
      id: createId("chk"),
      tool: input.tool,
      target: input.target,
      before: input.before,
      absentBefore: !!input.absentBefore,
      at: this.clock().toISOString(),
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
      ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    };
    this.records.push(record);
    this.trim();
    this.schedulePersist();
    return { ...record };
  }

  /** Record the post-state so a later rollback can detect drift. */
  async verify(id: string, after: JsonValue | null): Promise<CheckpointRecord | undefined> {
    await this.load();
    const record = this.records.find((r) => r.id === id);
    if (!record) return undefined;
    record.after = after;
    this.schedulePersist();
    return { ...record };
  }

  /**
   * Attempt to reverse a checkpoint. Returns:
   *   {applied: true, record} on success
   *   {applied: false, reason} on refusal (drift, already rolled back, unknown id,
   *                             no reverser, TTL expired)
   * Emits a `rollback.applied` or `rollback.refused` event with the outcome.
   */
  async rollback(id: string, opts: { correlationId?: string } = {}): Promise<
    | { applied: true; record: CheckpointRecord }
    | { applied: false; reason: string; record?: CheckpointRecord }
  > {
    await this.load();
    const record = this.records.find((r) => r.id === id);
    if (!record) return this.refuseRollback(undefined, "unknown", `No checkpoint with id '${id}'`, opts);
    if (record.rolledBackAt) {
      return this.refuseRollback(record, "already-rolled-back", "Checkpoint has already been rolled back.", opts);
    }
    if (this.isExpired(record)) {
      return this.refuseRollback(record, "expired", `Checkpoint expired after ${record.ttlMs}ms.`, opts);
    }
    const reverser = this.reversers.get(record.tool);
    if (!reverser) {
      return this.refuseRollback(record, "no-reverser", `No reverser registered for tool '${record.tool}'.`, opts);
    }
    let verifyOk = true;
    try {
      verifyOk = await reverser.verify(record);
    } catch (error) {
      return this.refuseRollback(
        record,
        "verify-threw",
        `Reverser.verify threw: ${error instanceof Error ? error.message : String(error)}`,
        opts,
      );
    }
    if (!verifyOk) {
      return this.refuseRollback(
        record,
        "drift",
        `Current state has drifted from the recorded post-image; refusing to overwrite later changes.`,
        opts,
      );
    }
    try {
      await reverser.restore(record);
    } catch (error) {
      const reason = `Restore failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit("rollback.failed", record, reason, opts);
      return { applied: false, reason, record };
    }
    record.rolledBackAt = this.clock().toISOString();
    this.schedulePersist();
    this.emit("rollback.applied", record, "Rollback applied.", opts);
    return { applied: true, record: { ...record } };
  }

  /** List recent checkpoints. Most recent last, oldest dropped by the trim. */
  async list(filter?: {
    limit?: number;
    tool?: string;
    workspaceId?: string;
    includeRolledBack?: boolean;
  }): Promise<CheckpointRecord[]> {
    await this.load();
    let out = this.records.slice();
    if (filter?.tool) out = out.filter((r) => r.tool === filter.tool);
    if (filter?.workspaceId) out = out.filter((r) => r.workspaceId === filter.workspaceId);
    if (!filter?.includeRolledBack) out = out.filter((r) => !r.rolledBackAt);
    // Drop expired ones from the returned view — they cannot be applied anyway.
    out = out.filter((r) => !this.isExpired(r));
    const limit = filter?.limit ?? 20;
    return out.slice(-limit).map((r) => ({ ...r }));
  }

  /** Flush pending writes for a clean shutdown. */
  async flush(): Promise<void> {
    await this.saving;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (!Array.isArray(raw)) return;
      const restored: CheckpointRecord[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const c = item as Partial<CheckpointRecord>;
        if (typeof c.id !== "string" || typeof c.tool !== "string" || typeof c.target !== "string") continue;
        if (typeof c.at !== "string" || typeof c.ttlMs !== "number") continue;
        restored.push({
          id: c.id,
          tool: c.tool,
          target: c.target,
          before: (c.before ?? null) as JsonValue | null,
          absentBefore: !!c.absentBefore,
          after: c.after as JsonValue | undefined,
          at: c.at,
          workspaceId: typeof c.workspaceId === "string" ? c.workspaceId : undefined,
          correlationId: typeof c.correlationId === "string" ? c.correlationId : undefined,
          ttlMs: c.ttlMs,
          rolledBackAt: typeof c.rolledBackAt === "string" ? c.rolledBackAt : undefined,
        });
      }
      this.records = restored;
      this.trim();
    } catch (error) {
      this.log.warn("rollback", "Could not load checkpoints; starting empty", {
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

  private isExpired(record: CheckpointRecord): boolean {
    const now = this.clock().getTime();
    const created = new Date(record.at).getTime();
    if (Number.isNaN(created)) return true;
    return now - created > record.ttlMs;
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
        this.log.warn("rollback", "Could not persist checkpoints", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private refuseRollback(
    record: CheckpointRecord | undefined,
    reason: string,
    detail: string,
    opts: { correlationId?: string },
  ): { applied: false; reason: string; record?: CheckpointRecord } {
    this.emit("rollback.refused", record, `${reason}: ${detail}`, opts);
    return { applied: false, reason: detail, record };
  }

  private emit(
    type: string,
    record: CheckpointRecord | undefined,
    detail: string,
    opts: { correlationId?: string },
  ): void {
    if (!this.events) return;
    this.events.emit({
      type,
      title: record ? `${type} for ${record.tool} on '${record.target}'` : type,
      detail,
      severity: type === "rollback.applied" ? "info" : "warn",
      correlationId: opts.correlationId ?? record?.correlationId,
      retention: "durable",
      provenance: { author: "subsystem", source: "checkpoint-store" },
      data: {
        checkpointId: record?.id,
        tool: record?.tool,
        target: record?.target,
      } as JsonObject,
    });
  }
}
