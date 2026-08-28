/**
 * Durable event journal.
 *
 * The EventBus's `events.recent` blob is a 500-entry hot ring — the whole thing is
 * overwritten each write, and anything older is unrecoverable. That is right for the
 * hot path (correlation, catchup, notifications) but wrong for a memory of what
 * happened: the mission's decision journal, catchup that spans a week, and future
 * cross-device continuity all need events that survive past the 501st emit.
 *
 * The journal is a second sink alongside the ring, not a replacement. It:
 *   - decides per-event whether to persist, from the event's own `retention` field or a
 *     default derived from `type` — no all-or-nothing partition
 *   - stores durable events in day-partitioned keys (`events.journal.YYYY-MM-DD`)
 *     rather than one blob, so a hydrate does not have to load a week of history to
 *     read yesterday
 *   - purges partitions older than the retention window on startup AND periodically
 *     during the session, so the journal cannot grow unbounded even in a long-lived
 *     process
 *   - writes best-effort — a journal write failure never blocks emit
 *   - is *forgiving* on hydrate: a corrupt partition costs its own history, never
 *     access to the other partitions
 *   - REJECTS caller-supplied inputs that would defeat the bounds: a malformed or
 *     future-dated `event.at` is clamped to now, an oversized data payload is
 *     truncated, an invalid retentionDays/maxPerDay is clamped to a ceiling, and
 *     invalid query filters (limit=0/NaN/negative, empty correlationId,
 *     unparseable since/until) are refused with a thrown error rather than
 *     silently returning "everything"
 *
 * Everything about durability is a choice about which loss story is louder:
 *   - if the ring loses history because the process ended, that is expected
 *   - if the journal loses history because a partition file is malformed, that is
 *     an incident and it is announced via a security-flavoured event on the ring
 *   - if the journal cannot accept a write, it says so — every write failure fires
 *     the onWriteFailure callback (not just the first per session)
 */

import type { StorageAdapter } from "./storage.ts";
import type { JsonValue, VesperEvent } from "./types.ts";
import type { Logger } from "./logging.ts";

const KEY_PREFIX = "events.journal.";
const KEY_PATTERN = /^events\.journal\.(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cap on the JSON size of a single event's `data` payload after admit(). A hostile or
 * buggy subsystem cannot inflate one partition beyond intent with a single write.
 * Chosen as a small multiple of a typical audit record; larger data belongs in a
 * dedicated store, not the durable event bus.
 */
const MAX_DATA_BYTES = 16 * 1024;

/** Hard ceiling on retention days — an operator who wants forever must say so elsewhere. */
const MAX_RETENTION_DAYS = 365;

/** Hard ceiling on events per day-partition — the "unbounded log" backstop. */
const MAX_PER_DAY = 50_000;

/**
 * Cap on the in-memory pending queue. If a storage write blocks for a very long time,
 * we drop the oldest pending events with a loud event rather than growing forever.
 */
const MAX_PENDING = 4096;

/** Purge the retention window this many admits into the session, to catch long-lived processes. */
const PURGE_EVERY_N_ADMITS = 500;

/**
 * Type-derived retention. The mission's rule is that "not every low-level transient
 * event needs permanent storage." This table is the deterministic answer for events
 * that do not name their own `retention`.
 *
 * Rules of thumb, in order of precedence:
 *   1. security.* is always durable — losing a security notice is an incident, even
 *      if the caller explicitly asked for "transient"
 *   2. state snapshots (obs.state, optimizer.state, system.state) are transient
 *   3. lifecycle chatter (idle_tick, background_start/stop) is transient
 *   4. routing chatter on the task queue (assigned/blocked/requeued) is transient
 *   5. everything else defaults to durable so an unknown event type is remembered
 *
 * A caller's explicit `retention` is respected EXCEPT for security.* (kept durable
 * always) and the transient denylist (kept transient always). The mission's two
 * hard rules — "security notices survive" and "background noise does not accumulate"
 * — cannot be overridden by an emitter.
 */
const TRANSIENT_TYPES = new Set<string>([
  "lifecycle.idle_tick",
  "lifecycle.background_start",
  "lifecycle.background_stop",
  "task.assigned",
  "task.blocked",
  "task.requeued",
  "obs.state",
  "optimizer.state",
  "system.state",
]);

export type RetentionDecision = "transient" | "durable" | "summary";

export function classifyRetention(event: Pick<VesperEvent, "type" | "retention">): RetentionDecision {
  // security.* is always durable, regardless of the caller's retention hint.
  if (event.type.startsWith("security.")) return "durable";
  // A named transient type is always transient — the caller cannot promote background
  // noise to durable retention.
  if (TRANSIENT_TYPES.has(event.type)) return "transient";
  if (event.retention) return event.retention;
  return "durable";
}

export interface EventJournalOptions {
  storage: StorageAdapter;
  log: Logger;
  /** Day-partitions kept; clamped to [1, 365]. */
  retentionDays?: number;
  /** Max events per day-partition; clamped to [50, 50000]. */
  maxPerDay?: number;
  /** Injected clock, so tests can pin dates. */
  now?: () => Date;
  /** Called every write failure so a sustained outage stays loud. */
  onWriteFailure?: (error: unknown) => void;
  /** Called (once per session) when a corrupt partition is dropped. */
  onCorruptPartition?: (key: string, error: unknown) => void;
}

export interface JournalQuery {
  types?: string[];
  since?: string;
  until?: string;
  correlationId?: string;
  limit?: number;
}

export class EventJournal {
  private readonly storage: StorageAdapter;
  private readonly log: Logger;
  private readonly retentionDays: number;
  private readonly maxPerDay: number;
  private readonly clock: () => Date;
  private readonly onWriteFailure: ((error: unknown) => void) | undefined;
  private readonly onCorruptPartition: ((key: string, error: unknown) => void) | undefined;
  private saving: Promise<void> = Promise.resolve();
  private pending: VesperEvent[] = [];
  private saveQueued = false;
  private admitsSincePurge = 0;
  private reportedCorrupt = new Set<string>();

  constructor(options: EventJournalOptions) {
    this.storage = options.storage;
    this.log = options.log;
    const rawRetention = Math.floor(options.retentionDays ?? 14);
    this.retentionDays = Number.isFinite(rawRetention)
      ? Math.max(1, Math.min(MAX_RETENTION_DAYS, rawRetention))
      : 14;
    const rawMax = Math.floor(options.maxPerDay ?? 1000);
    this.maxPerDay = Number.isFinite(rawMax)
      ? Math.max(50, Math.min(MAX_PER_DAY, rawMax))
      : 1000;
    this.clock = options.now ?? (() => new Date());
    this.onWriteFailure = options.onWriteFailure;
    this.onCorruptPartition = options.onCorruptPartition;
  }

  /**
   * Admit an event. Transient events are dropped. Durable events are normalised
   * (malformed `at` is clamped to now; oversized `data` is truncated) before enqueue.
   * Batching lets a burst of emits produce a single write, matching the ring's
   * `schedulePersist` coalescing. If the pending queue exceeds MAX_PENDING (storage
   * hanging), we drop the OLDEST pending events with a loud event and keep the new
   * ones — a persisting hang cannot cost this device's ability to accept new writes.
   */
  admit(event: VesperEvent): RetentionDecision {
    const decision = classifyRetention(event);
    if (decision === "transient") return decision;
    const normalised = this.normalise(event);
    this.pending.push(normalised);
    if (this.pending.length > MAX_PENDING) {
      const dropped = this.pending.splice(0, this.pending.length - MAX_PENDING);
      // Sustained back-pressure is not a normal condition. Log it and — the mission's
      // "loss must be loud" rule — invoke the failure callback so the bus can surface
      // it. Even though nothing threw here, information WAS lost.
      this.log.warn("event", "Journal pending queue overflowed; oldest events dropped", {
        droppedCount: dropped.length,
        pendingSize: this.pending.length,
      });
      this.onWriteFailure?.(new Error(`Journal pending overflow: dropped ${dropped.length} events`));
    }
    this.schedulePersist();
    // Long-lived process: run the retention purge periodically so a running Vesper
    // does not accumulate months of partitions.
    this.admitsSincePurge += 1;
    if (this.admitsSincePurge >= PURGE_EVERY_N_ADMITS) {
      this.admitsSincePurge = 0;
      // Best effort, non-blocking on admit.
      void this.purgeStaleUnthrottled().catch(() => undefined);
    }
    return decision;
  }

  /** Flush pending writes; caller uses this on clean shutdown. Chained to catch late admits. */
  async flush(): Promise<void> {
    // A late admit chains onto this.saving after we started to await; re-await until
    // the queue is empty.
    let previous: Promise<void> | undefined;
    while (previous !== this.saving) {
      previous = this.saving;
      await previous;
    }
  }

  /**
   * Purge partitions older than the retention window. Called on startup AND
   * periodically (see admit()). Both call sites are idempotent by design — this
   * method is safe to invoke as often as needed.
   */
  async purgeOldPartitions(): Promise<number> {
    return this.purgeStaleUnthrottled();
  }

  private async purgeStaleUnthrottled(): Promise<number> {
    try {
      const keys = await this.storage.keys();
      const cutoff = this.cutoffDateString();
      const today = this.todayDateString();
      let purged = 0;
      for (const key of keys) {
        const m = KEY_PATTERN.exec(key);
        if (!m) continue;
        const date = `${m[1]}-${m[2]}-${m[3]}`;
        // Purge anything OLDER than the retention window OR wildly future-dated
        // (a bogus timestamp planted a "9999-12-31" partition and would otherwise
        // survive forever).
        if (date < cutoff || date > today) {
          try {
            await this.storage.delete(key);
            purged += 1;
          } catch (error) {
            // A failed delete is honestly reported, not silently dropped: the "unbounded
            // log" bound depends on this succeeding, so failures matter.
            this.log.warn("event", "Journal purge could not delete partition", {
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return purged;
    } catch (error) {
      this.log.warn("event", "Could not enumerate storage for journal pruning", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Read journaled events matching the filter. Every input parameter is validated;
   * a caller passing a nonsense filter gets a thrown error, never a silently wider
   * result set.
   */
  async query(filter: JournalQuery = {}): Promise<VesperEvent[]> {
    // Input validation — every one of these was a real filter-bypass finding.
    if (filter.limit !== undefined) {
      if (typeof filter.limit !== "number" || !Number.isFinite(filter.limit) || filter.limit <= 0 || filter.limit !== Math.floor(filter.limit)) {
        throw new Error(`Journal query limit must be a positive integer; got ${filter.limit}`);
      }
    }
    if (filter.correlationId !== undefined && (typeof filter.correlationId !== "string" || filter.correlationId.length === 0)) {
      throw new Error(`Journal query correlationId must be a non-empty string`);
    }
    if (filter.since !== undefined && !this.isValidIso(filter.since)) {
      throw new Error(`Journal query 'since' must be a valid ISO timestamp; got '${filter.since}'`);
    }
    if (filter.until !== undefined && !this.isValidIso(filter.until)) {
      throw new Error(`Journal query 'until' must be a valid ISO timestamp; got '${filter.until}'`);
    }

    await this.flush();
    const partitions = await this.listPartitions();
    const from = filter.since ? this.partitionKeyForIso(filter.since) : null;
    const until = filter.until ? this.partitionKeyForIso(filter.until) : null;
    const relevant = partitions.filter((key) => {
      if (from && key < from) return false;
      if (until && key > until) return false;
      return true;
    });
    const matches: VesperEvent[] = [];
    const seenIds = new Set<string>();
    for (const key of relevant) {
      const events = await this.readPartition(key);
      for (const event of events) {
        // A single event id must never appear twice — a duplicate on disk (from a
        // partial write or a shared-storage race) would otherwise pollute the result.
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        if (filter.types && !filter.types.includes(event.type)) continue;
        if (filter.since && event.at < filter.since) continue;
        if (filter.until && event.at > filter.until) continue;
        if (filter.correlationId && event.correlationId !== filter.correlationId) continue;
        matches.push(event);
      }
    }
    matches.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return filter.limit ? matches.slice(-filter.limit) : matches;
  }

  /**
   * Normalise an incoming event for admission: clamp malformed / future timestamps to
   * the injected clock; truncate oversized data payloads. Never mutates the caller's
   * event.
   */
  private normalise(event: VesperEvent): VesperEvent {
    let at = event.at;
    if (!this.isValidIso(at)) {
      at = this.clock().toISOString();
    } else {
      const eventTime = new Date(at).getTime();
      const now = this.clock().getTime();
      // Future-dated events are clamped to now, so a `9999-12-31` cannot plant a
      // partition that outlives the retention window by millennia.
      if (eventTime > now + 60_000) {
        at = new Date(now).toISOString();
      }
    }
    let data = event.data;
    if (data !== undefined) {
      try {
        const encoded = JSON.stringify(data);
        if (encoded.length > MAX_DATA_BYTES) {
          data = { truncated: true, originalSizeBytes: encoded.length } as never;
          this.log.warn("event", "Journal truncated an oversized data payload", {
            type: event.type,
            originalSizeBytes: encoded.length,
          });
        }
      } catch {
        // A data payload that cannot be JSON-serialised is a bug; drop it rather than
        // corrupt the partition.
        data = { truncated: true, reason: "not-serialisable" } as never;
      }
    }
    return { ...event, at, data };
  }

  private isValidIso(s: unknown): s is string {
    if (typeof s !== "string" || s.length === 0) return false;
    // Require full ISO 8601 with time component to prevent bare-date filter bugs.
    // Timezone must be Z or ±HH:MM (avoid ambiguity across day boundaries).
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
    return !Number.isNaN(new Date(s).getTime());
  }

  private schedulePersist(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving
      .then(async () => {
        this.saveQueued = false;
        const toWrite = this.pending;
        this.pending = [];
        if (toWrite.length === 0) return;
        try {
          await this.appendToPartitions(toWrite);
        } catch (error) {
          // A failed write is loud EVERY TIME — the mission's "sustained loss goes
          // quiet after the first alert" defect was that the previous version
          // debounced this once per session.
          this.log.warn("event", "Could not persist to the event journal", {
            error: error instanceof Error ? error.message : String(error),
            dropped: toWrite.length,
          });
          this.onWriteFailure?.(error);
          // Re-queue the events so a later retry can take them. If they've filled the
          // pending buffer past MAX_PENDING, admit()'s next call will drop the oldest.
          this.pending = [...toWrite, ...this.pending];
        }
      })
      .catch((error: unknown) => {
        this.saveQueued = false;
        this.log.error("event", "Unexpected error in journal persist chain", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.onWriteFailure?.(error);
      });
  }

  private async appendToPartitions(events: VesperEvent[]): Promise<void> {
    // Group by day so a burst that straddles midnight still writes both partitions.
    const byDay = new Map<string, VesperEvent[]>();
    for (const event of events) {
      const key = this.partitionKeyForIso(event.at);
      const bucket = byDay.get(key) ?? [];
      bucket.push(event);
      byDay.set(key, bucket);
    }
    for (const [key, incoming] of byDay) {
      const existing = await this.readPartition(key);
      // Merge and dedupe by id: a shared-storage race can otherwise duplicate.
      const seenIds = new Set(existing.map((e) => e.id));
      const additions = incoming.filter((e) => !seenIds.has(e.id));
      const merged = [...existing, ...additions];
      const bounded = merged.length > this.maxPerDay ? merged.slice(-this.maxPerDay) : merged;
      // Announce truncation of the earliest events so the "loss must be loud" rule
      // covers this path too.
      if (merged.length > this.maxPerDay) {
        const droppedCount = merged.length - this.maxPerDay;
        this.log.warn("event", "Journal partition exceeded maxPerDay; oldest events dropped", {
          key,
          droppedCount,
          cap: this.maxPerDay,
        });
        // Not calling onWriteFailure here because THIS write succeeded — the truncation
        // is a policy consequence, not a failure. The log entry is the audit trail.
      }
      await this.storage.set(key, bounded as unknown as JsonValue);
    }
  }

  private async readPartition(key: string): Promise<VesperEvent[]> {
    let raw: unknown;
    try {
      raw = await this.storage.get(key);
    } catch (error) {
      // A transient read failure could otherwise cause the next write to overwrite
      // the partition with just the new events — losing the readable history. The
      // fix is to THROW: the caller (query or appendToPartitions) handles the throw
      // rather than treating "cannot read" as "empty".
      throw error;
    }
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      return this.markCorruptAndReturnEmpty(key, new Error("Journal partition is not an array"));
    }
    const events: VesperEvent[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const c = item as Record<string, unknown>;
      if (
        typeof c.id !== "string" ||
        typeof c.at !== "string" ||
        typeof c.type !== "string" ||
        typeof c.title !== "string" ||
        (c.severity !== "info" && c.severity !== "warn" && c.severity !== "error")
      ) {
        continue;
      }
      events.push(c as unknown as VesperEvent);
    }
    return events;
  }

  private markCorruptAndReturnEmpty(key: string, error: unknown): VesperEvent[] {
    this.log.warn("event", "Corrupt event-journal partition, skipping", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!this.reportedCorrupt.has(key)) {
      this.reportedCorrupt.add(key);
      this.onCorruptPartition?.(key, error);
    }
    return [];
  }

  private async listPartitions(): Promise<string[]> {
    try {
      const keys = await this.storage.keys();
      return keys.filter((key) => KEY_PATTERN.test(key)).sort();
    } catch {
      return [];
    }
  }

  private partitionKeyForIso(iso: string): string {
    // Guard against caller-supplied `at` bypassing normalise() (e.g. queries): if the
    // first 10 chars are not a valid date, fall back to today so we do not create a
    // ghost partition invisible to purge/list.
    const date = iso.slice(0, 10);
    if (!ISO_DATE_ONLY.test(date)) {
      return `${KEY_PREFIX}${this.todayDateString()}`;
    }
    return `${KEY_PREFIX}${date}`;
  }

  private todayDateString(): string {
    const now = this.clock();
    return `${now.getUTCFullYear().toString().padStart(4, "0")}-${(now.getUTCMonth() + 1)
      .toString()
      .padStart(2, "0")}-${now.getUTCDate().toString().padStart(2, "0")}`;
  }

  private cutoffDateString(): string {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    if (Number.isNaN(cutoff.getTime())) return "0000-00-00";
    const yyyy = cutoff.getUTCFullYear().toString().padStart(4, "0");
    const mm = (cutoff.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = cutoff.getUTCDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
}
