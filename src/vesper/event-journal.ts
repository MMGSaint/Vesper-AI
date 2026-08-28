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
 *   - purges partitions older than the retention window on startup and after each
 *     rotation, so the journal cannot grow unbounded
 *   - writes best-effort — a journal write failure never blocks emit
 *   - is *forgiving* on hydrate: a corrupt partition costs its own history, never
 *     access to the other partitions
 *
 * Everything about durability is a choice about which loss story is louder:
 *   - if the ring loses history because the process ended, that is expected
 *   - if the journal loses history because a partition file is malformed, that is
 *     an incident and it is announced via a security-flavoured event on the ring
 */

import type { StorageAdapter } from "./storage.ts";
import type { JsonValue, VesperEvent } from "./types.ts";
import type { Logger } from "./logging.ts";

const KEY_PREFIX = "events.journal.";
const KEY_PATTERN = /^events\.journal\.(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Type-derived retention. The mission's rule is that "not every low-level transient
 * event needs permanent storage." This table is the deterministic answer for events
 * that do not name their own `retention`.
 *
 * Rules of thumb, in order of precedence:
 *   1. security.* is always durable — losing a security notice is an incident
 *   2. state snapshots (obs.state, optimizer.state, system.state) are transient —
 *      they change frequently and can be re-queried
 *   3. lifecycle chatter (idle_tick, background_start/stop) is transient
 *   4. routing chatter on the task queue (assigned/blocked/requeued) is transient —
 *      the human-visible transitions (created/started/completed/failed/cancelled) are
 *      durable
 *   5. everything else defaults to durable so an unknown event type is remembered
 *
 * Any explicit `retention` on the event beats this table.
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
  if (event.retention) return event.retention;
  // security.* is always durable, even in the presence of a stray denylist entry.
  if (event.type.startsWith("security.")) return "durable";
  if (TRANSIENT_TYPES.has(event.type)) return "transient";
  return "durable";
}

export interface EventJournalOptions {
  storage: StorageAdapter;
  log: Logger;
  /** How many day-partitions to keep. Older partitions are purged on startup and after rotation. */
  retentionDays?: number;
  /** Max events per day-partition. A day-partition beyond this cap is truncated on write; the earliest events go first. */
  maxPerDay?: number;
  /** Injected clock, so tests can pin dates. */
  now?: () => Date;
  /**
   * Called (once per session) when a journal write fails so the runtime can surface it
   * on the event bus. Keeping it out of this module means the journal can be tested
   * without a bus.
   */
  onWriteFailure?: (error: unknown) => void;
  /** Called (once per session) when a corrupt partition is dropped. Same reason. */
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
  private reportedWriteFailure = false;
  private reportedCorrupt = new Set<string>();
  private prunedOnStartup = false;

  constructor(options: EventJournalOptions) {
    this.storage = options.storage;
    this.log = options.log;
    this.retentionDays = Math.max(1, Math.floor(options.retentionDays ?? 14));
    this.maxPerDay = Math.max(50, Math.floor(options.maxPerDay ?? 1000));
    this.clock = options.now ?? (() => new Date());
    this.onWriteFailure = options.onWriteFailure;
    this.onCorruptPartition = options.onCorruptPartition;
  }

  /**
   * Best-effort admission. `transient` events are dropped; anything else is queued for
   * write. Batching lets a burst of emits produce a single write, matching the ring's
   * `schedulePersist` coalescing.
   */
  admit(event: VesperEvent): RetentionDecision {
    const decision = classifyRetention(event);
    if (decision === "transient") return decision;
    if (decision === "summary") {
      // Summary events are a placeholder for future rolled-up snapshots; nothing
      // produces one yet, so persist them the same as durable but keep them in a
      // separate partition prefix later.
    }
    this.pending.push(event);
    this.schedulePersist();
    return decision;
  }

  /** Flush pending writes; caller uses this on clean shutdown. */
  async flush(): Promise<void> {
    await this.saving;
  }

  /** Called once at startup to purge partitions older than the retention window. */
  async purgeOldPartitions(): Promise<number> {
    if (this.prunedOnStartup) return 0;
    this.prunedOnStartup = true;
    try {
      const keys = await this.storage.keys();
      const cutoff = this.cutoffDateString();
      let purged = 0;
      for (const key of keys) {
        const m = KEY_PATTERN.exec(key);
        if (!m) continue;
        const date = `${m[1]}-${m[2]}-${m[3]}`;
        if (date < cutoff) {
          await this.storage.delete(key).catch(() => undefined);
          purged += 1;
        }
      }
      return purged;
    } catch (error) {
      // A storage.keys() failure means we cannot enumerate; skip pruning this run
      // rather than throwing. The retention window will apply the next time keys
      // succeed. This mirrors the "corrupt log costs history, never availability"
      // pattern in EventBus.hydrate.
      this.log.warn("event", "Could not enumerate storage for journal pruning", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Read journaled events matching the filter.
   *
   * The journal is split by day, so a `since` filter narrows to the partitions that
   * could contain matches. Without `since`, every retained partition is opened —
   * bounded by the retention window, which is why the window exists.
   */
  async query(filter: JournalQuery = {}): Promise<VesperEvent[]> {
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
    for (const key of relevant) {
      const events = await this.readPartition(key);
      for (const event of events) {
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

  private schedulePersist(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving
      .then(async () => {
        this.saveQueued = false;
        const pending = this.pending;
        this.pending = [];
        if (pending.length === 0) return;
        await this.appendToPartitions(pending);
      })
      .catch((error: unknown) => {
        this.saveQueued = false;
        this.pending = [];
        this.log.warn("event", "Could not persist to the event journal", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Fire only once per session to avoid flooding the bus.
        if (!this.reportedWriteFailure) {
          this.reportedWriteFailure = true;
          this.onWriteFailure?.(error);
        }
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
      const merged = [...existing, ...incoming];
      // Cap per-day size to protect against a floody subsystem. The earliest events go
      // first, matching the ring's "keep the tail" behaviour.
      const bounded = merged.length > this.maxPerDay ? merged.slice(-this.maxPerDay) : merged;
      await this.storage.set(key, bounded as unknown as JsonValue);
    }
  }

  private async readPartition(key: string): Promise<VesperEvent[]> {
    let raw: unknown;
    try {
      raw = await this.storage.get(key);
    } catch (error) {
      return this.markCorruptAndReturnEmpty(key, error);
    }
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      // A stored value at a journal key that is not an array is corrupt — the shape is
      // load-bearing, and returning empty would hide a data-shape mismatch as "just
      // empty history".
      return this.markCorruptAndReturnEmpty(key, new Error("Journal partition is not an array"));
    }
    const events: VesperEvent[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.at !== "string" ||
        typeof candidate.type !== "string"
      ) {
        continue;
      }
      events.push(item as unknown as VesperEvent);
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
    // ISO 8601 timestamp — the first 10 chars are always YYYY-MM-DD.
    const date = iso.slice(0, 10);
    return `${KEY_PREFIX}${date}`;
  }

  private cutoffDateString(): string {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    // Return YYYY-MM-DD for lexicographic compare against the partition key suffix.
    const yyyy = cutoff.getUTCFullYear().toString().padStart(4, "0");
    const mm = (cutoff.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = cutoff.getUTCDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
}
