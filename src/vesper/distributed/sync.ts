/**
 * Cross-device synchronisation.
 *
 * Offline-first by construction: every device works from local state and queues what it
 * has to send. The network is never a dependency for using Vesper, only for agreeing
 * with the other devices later.
 *
 * The hard part is not moving records, it is deciding which version is right without
 * silently destroying the other. Last-write-wins is not used as a blanket rule: two
 * devices editing the same fact from the same base is a genuine disagreement, and
 * quietly picking one is how a user loses something they wrote.
 */

import type { MemoryEntry } from "../types.ts";
import { isSyncable } from "../memory/scopes.ts";

/** Keys whose presence means a payload must never leave the device. */
const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key)/i;

export const SYNC_DECISIONS = ["identical", "local", "remote", "conflict"] as const;
export type SyncDecision = (typeof SYNC_DECISIONS)[number];

export interface Resolution {
  decision: SyncDecision;
  winner?: MemoryEntry;
  reason: string;
}

/**
 * Resolve two versions of the same memory entry.
 *
 * Ordering rules, in order:
 *   1. identical content            -> nothing to do
 *   2. a device-scoped fact about different machines -> never merged, always a conflict
 *   3. one side strictly ahead      -> that side wins
 *   4. same revision, different text -> genuine divergence, reported as a conflict
 *
 * Rule 2 matters most. "My GPU is a 7900 XT" from the desktop and "my GPU is a 4060"
 * from the laptop are both true; picking one would make Vesper wrong about a machine.
 */
export function resolveMemoryConflict(local: MemoryEntry, remote: MemoryEntry): Resolution {
  if (local.value === remote.value && local.scope === remote.scope) {
    return { decision: "identical", winner: local, reason: "Both sides already agree." };
  }

  if (local.scope === "device" || remote.scope === "device") {
    if ((local.deviceId ?? "") !== (remote.deviceId ?? "")) {
      return {
        decision: "conflict",
        reason:
          "These are device-scoped facts about different machines. Both are kept; merging them would make Vesper wrong about one of them.",
      };
    }
  }

  if (local.revision > remote.revision) {
    return {
      decision: "local",
      winner: local,
      reason: `Local revision ${local.revision} is ahead of ${remote.revision}.`,
    };
  }
  if (remote.revision > local.revision) {
    return {
      decision: "remote",
      winner: remote,
      reason: `Remote revision ${remote.revision} is ahead of ${local.revision}.`,
    };
  }

  // Same revision, different content: both devices edited from the same base. There is
  // no evidence for preferring either, so the disagreement is surfaced rather than
  // resolved by coin-flip.
  return {
    decision: "conflict",
    reason: `Both devices edited revision ${local.revision} independently. Neither version is discarded.`,
  };
}

export interface SyncFilterResult {
  send: MemoryEntry[];
  withheld: { key: string; reason: string }[];
}

/**
 * Decide what may leave this device.
 *
 * Two independent filters, both of which must pass: the scope must be syncable, and the
 * content must not look like a secret. The second exists because scope is a
 * classification the user controls and a mistake there should not become an exfiltration.
 */
export function filterForSync(entries: MemoryEntry[]): SyncFilterResult {
  const send: MemoryEntry[] = [];
  const withheld: { key: string; reason: string }[] = [];
  for (const entry of entries) {
    if (!isSyncable(entry.scope)) {
      withheld.push({ key: entry.key, reason: `scope '${entry.scope}' never leaves the device` });
      continue;
    }
    if (SECRET_KEY.test(entry.key) || SECRET_KEY.test(entry.value)) {
      withheld.push({ key: entry.key, reason: "looks like a credential" });
      continue;
    }
    send.push(entry);
  }
  return { send, withheld };
}

/**
 * A scoped request, so a device pulls what it needs rather than the whole store.
 *
 * This matters most for a portable session: a Vesper on a borrowed computer asking
 * "what do I use for streaming?" should retrieve the streaming memories, not download
 * the user's entire life onto an untrusted host.
 */
export interface SyncQuery {
  scopes?: MemoryEntry["scope"][];
  workspaceId?: string;
  /** Free-text narrowing, so a portable pull stays minimal. */
  match?: string;
  limit?: number;
}

export function selectForQuery(entries: MemoryEntry[], query: SyncQuery): MemoryEntry[] {
  const wanted = new Set(query.scopes ?? ["device", "workspace", "user", "global"]);
  const needle = query.match?.trim().toLowerCase();
  const matched = entries.filter((entry) => {
    if (!wanted.has(entry.scope)) return false;
    if (query.workspaceId && entry.scope === "workspace" && entry.workspaceId !== query.workspaceId) {
      return false;
    }
    if (!needle) return true;
    return `${entry.key} ${entry.value}`.toLowerCase().includes(needle);
  });
  return matched.slice(0, Math.max(1, query.limit ?? 50));
}

export interface QueuedChange {
  entry: MemoryEntry;
  queuedAt: string;
}

export interface SyncOutcome {
  applied: number;
  conflicts: { key: string; reason: string }[];
  withheld: { key: string; reason: string }[];
  /** Set when the peer could not be reached; the queue is preserved. */
  offlineReason: string | null;
}

export interface SyncTransport {
  /** Push local changes. Throws or rejects when the peer is unreachable. */
  push(changes: MemoryEntry[]): Promise<void>;
  /** Pull the peer's view for a scoped query. */
  pull(query: SyncQuery): Promise<MemoryEntry[]>;
}

/**
 * Offline-first sync engine.
 *
 * Local changes accumulate in a queue that survives being offline. A failed exchange
 * leaves the queue intact and reports why; it never drops work to make the operation
 * look successful.
 */
export class SyncEngine {
  private outbound: QueuedChange[] = [];
  private readonly now: () => string;
  private readonly maxQueue: number;

  constructor(options?: { now?: () => string; maxQueue?: number }) {
    this.now = options?.now ?? (() => new Date().toISOString());
    this.maxQueue = Math.max(16, options?.maxQueue ?? 1000);
  }

  /** Queue a local change for the next exchange. Secrets never enter the queue. */
  enqueue(entries: MemoryEntry[]): SyncFilterResult {
    const filtered = filterForSync(entries);
    for (const entry of filtered.send) {
      // One queue slot per key: the newest version of a fact is the one worth sending.
      const existing = this.outbound.findIndex((item) => item.entry.key === entry.key);
      if (existing >= 0) this.outbound.splice(existing, 1);
      this.outbound.push({ entry, queuedAt: this.now() });
    }
    if (this.outbound.length > this.maxQueue) {
      this.outbound.splice(0, this.outbound.length - this.maxQueue);
    }
    return filtered;
  }

  get pending(): number {
    return this.outbound.length;
  }

  /**
   * Exchange with a peer. Returns what happened rather than throwing: a device that
   * cannot sync must keep working, and the caller needs to know it did not.
   */
  async exchange(input: {
    transport: SyncTransport;
    local: MemoryEntry[];
    query: SyncQuery;
    apply: (entry: MemoryEntry) => Promise<void> | void;
  }): Promise<SyncOutcome> {
    const conflicts: { key: string; reason: string }[] = [];
    const withheld: { key: string; reason: string }[] = [];
    let applied = 0;

    const toPush = this.outbound.map((item) => item.entry);
    try {
      if (toPush.length) await input.transport.push(toPush);
      // Only clear the queue once the peer has actually taken the changes.
      this.outbound = [];
    } catch (error) {
      return {
        applied: 0,
        conflicts,
        withheld,
        offlineReason: `Push failed, ${this.outbound.length} change(s) still queued: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    let remote: MemoryEntry[];
    try {
      remote = await input.transport.pull(input.query);
    } catch (error) {
      return {
        applied: 0,
        conflicts,
        withheld,
        offlineReason: `Pull failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const byKey = new Map(input.local.map((entry) => [entry.key, entry]));
    for (const incoming of remote) {
      const filtered = filterForSync([incoming]);
      if (!filtered.send.length) {
        withheld.push(...filtered.withheld);
        continue;
      }
      const mine = byKey.get(incoming.key);
      if (!mine) {
        await input.apply(incoming);
        applied += 1;
        continue;
      }
      const resolution = resolveMemoryConflict(mine, incoming);
      if (resolution.decision === "remote" && resolution.winner) {
        await input.apply(resolution.winner);
        applied += 1;
      } else if (resolution.decision === "conflict") {
        conflicts.push({ key: incoming.key, reason: resolution.reason });
      }
    }

    return { applied, conflicts, withheld, offlineReason: null };
  }
}
