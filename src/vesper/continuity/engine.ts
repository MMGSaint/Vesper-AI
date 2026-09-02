/**
 * Local outbox / inbox.
 *
 * LOCAL WRITE → LOCAL STATE COMMITTED → SYNC EVENT → OUTBOX → PUSH → REMOTE
 * → PULL → INBOX → VERIFY → MERGE → LOCAL STATE
 *
 * Offline-safe, idempotent, restart-safe, bounded retry. A failed exchange leaves
 * the queue intact. Duplicate delivery is a no-op. Sync never executes tools.
 */

import type { JsonObject } from "../types.ts";
import type { CloudAuth, CloudSyncProvider } from "./cloud.ts";
import { decryptEnvelope, encryptEnvelope, type Keyring } from "./crypto.ts";
import { conflictKindFor, mayApplyIncoming, mayEnterCloud } from "./policy.ts";
import { verifyRecordIntegrity } from "./records.ts";
import { trustAfterSync, type EncryptedEnvelope, type SyncRecord } from "./types.ts";
import { MAX_SYNC_RECORDS_PER_PUSH } from "./types.ts";

export interface OutboxItem {
  record: SyncRecord;
  queuedAt: string;
  attempts: number;
  nextRetryAt: string;
  lastError: string | null;
}

export interface InboxApply {
  (record: SyncRecord): Promise<void> | void;
}

export interface ContinuityCheckpoint {
  cursor: string;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}

export interface ExchangeOutcome {
  pushed: number;
  pulled: number;
  applied: number;
  conflicts: { entityId: string; reason: string; kind: string; resolution: string }[];
  withheld: { recordId: string; reason: string }[];
  rejected: { recordId: string; reason: string }[];
  offlineReason: string | null;
  cursor: string;
}

const MAX_QUEUE = 1000;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1_000;

export class ContinuityEngine {
  private outbox: OutboxItem[] = [];
  private applied = new Set<string>();
  private checkpoint: ContinuityCheckpoint = {
    cursor: "0",
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
  };
  private readonly now: () => string;
  private readonly localDeviceId: string;

  constructor(options: { localDeviceId: string; now?: () => string }) {
    this.localDeviceId = options.localDeviceId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get pending(): number {
    return this.outbox.length;
  }

  getCheckpoint(): ContinuityCheckpoint {
    return { ...this.checkpoint };
  }

  restore(input: { outbox?: OutboxItem[]; checkpoint?: ContinuityCheckpoint; applied?: string[] }): void {
    if (input.outbox) this.outbox = input.outbox.map((item) => ({ ...item, record: { ...item.record } }));
    if (input.checkpoint) this.checkpoint = { ...input.checkpoint };
    if (input.applied) this.applied = new Set(input.applied);
  }

  snapshot(): { outbox: OutboxItem[]; checkpoint: ContinuityCheckpoint; applied: string[] } {
    return {
      outbox: this.outbox.map((item) => ({ ...item, record: { ...item.record } })),
      checkpoint: { ...this.checkpoint },
      applied: [...this.applied],
    };
  }

  enqueue(record: SyncRecord): { queued: boolean; reason: string } {
    const policy = mayEnterCloud(record);
    if (!policy.allowed) return { queued: false, reason: policy.reason };
    if (!verifyRecordIntegrity(record)) return { queued: false, reason: "integrity hash mismatch" };
    const existing = this.outbox.findIndex((item) => item.record.entityId === record.entityId && item.record.entityType === record.entityType);
    if (existing >= 0) this.outbox.splice(existing, 1);
    this.outbox.push({
      record,
      queuedAt: this.now(),
      attempts: 0,
      nextRetryAt: this.now(),
      lastError: null,
    });
    if (this.outbox.length > MAX_QUEUE) this.outbox.splice(0, this.outbox.length - MAX_QUEUE);
    return { queued: true, reason: "queued" };
  }

  async exchange(input: {
    provider: CloudSyncProvider;
    auth: CloudAuth;
    ring: Keyring;
    local: SyncRecord[];
    apply: InboxApply;
    senderRevoked?: (deviceId: string) => boolean | Promise<boolean>;
    senderSuspended?: (deviceId: string) => boolean | Promise<boolean>;
  }): Promise<ExchangeOutcome> {
    const withheld: { recordId: string; reason: string }[] = [];
    const rejected: { recordId: string; reason: string }[] = [];
    const conflicts: ExchangeOutcome["conflicts"] = [];
    let pushed = 0;
    let pulled = 0;
    let applied = 0;

    const due = this.outbox.filter((item) => item.nextRetryAt <= this.now()).slice(0, MAX_SYNC_RECORDS_PER_PUSH);
    const envelopes: EncryptedEnvelope[] = [];
    for (const item of due) {
      try {
        envelopes.push(
          encryptEnvelope({
            recordId: item.record.recordId,
            entityType: item.record.entityType,
            sourceDeviceId: item.record.sourceDeviceId,
            plaintext: JSON.stringify(item.record),
            ring: input.ring,
          }),
        );
      } catch (error) {
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message : String(error);
        item.nextRetryAt = this.backoff(item.attempts);
        rejected.push({ recordId: item.record.recordId, reason: item.lastError });
      }
    }

    if (envelopes.length) {
      try {
        const result = await input.provider.push(input.auth, envelopes);
        pushed = result.accepted;
        const pushedIds = new Set(envelopes.map((item) => item.recordId));
        for (const fail of result.rejected) {
          rejected.push(fail);
          const queued = this.outbox.find((item) => item.record.recordId === fail.recordId);
          if (queued) {
            queued.attempts += 1;
            queued.lastError = fail.reason;
            queued.nextRetryAt = this.backoff(queued.attempts);
            if (queued.attempts >= MAX_ATTEMPTS) {
              this.outbox = this.outbox.filter((item) => item.record.recordId !== fail.recordId);
            }
          }
          pushedIds.delete(fail.recordId);
        }
        this.outbox = this.outbox.filter((item) => !pushedIds.has(item.record.recordId));
        this.checkpoint.lastPushAt = this.now();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.checkpoint.lastError = reason;
        for (const item of due) {
          item.attempts += 1;
          item.lastError = reason;
          item.nextRetryAt = this.backoff(item.attempts);
        }
        return {
          pushed: 0,
          pulled: 0,
          applied: 0,
          conflicts,
          withheld,
          rejected,
          offlineReason: `Push failed, ${this.outbox.length} change(s) still queued: ${reason}`,
          cursor: this.checkpoint.cursor,
        };
      }
    }

    let pull;
    try {
      pull = await input.provider.pull(input.auth, this.checkpoint.cursor);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.checkpoint.lastError = reason;
      return {
        pushed,
        pulled: 0,
        applied: 0,
        conflicts,
        withheld,
        rejected,
        offlineReason: `Pull failed: ${reason}`,
        cursor: this.checkpoint.cursor,
      };
    }

    pulled = pull.envelopes.length;
    const byEntity = new Map(input.local.map((record) => [`${record.entityType}:${record.entityId}`, record]));

    for (const envelope of pull.envelopes) {
      const decrypted = decryptEnvelope(envelope, input.ring);
      if (!decrypted.ok) {
        rejected.push({ recordId: envelope.recordId, reason: decrypted.reason });
        continue;
      }
      let incoming: SyncRecord;
      try {
        incoming = JSON.parse(decrypted.plaintext.toString("utf8")) as SyncRecord;
      } catch {
        rejected.push({ recordId: envelope.recordId, reason: "malformed record" });
        continue;
      }
      if (!verifyRecordIntegrity(incoming)) {
        rejected.push({ recordId: incoming.recordId, reason: "tampered payload" });
        continue;
      }
      const applyGate = mayApplyIncoming({
        record: incoming,
        localDeviceId: this.localDeviceId,
        senderRevoked: Boolean(await input.senderRevoked?.(incoming.sourceDeviceId)),
        senderSuspended: Boolean(await input.senderSuspended?.(incoming.sourceDeviceId)),
      });
      if (!applyGate.allowed) {
        withheld.push({ recordId: incoming.recordId, reason: applyGate.reason });
        continue;
      }
      const dedupeKey = `${incoming.recordId}:${incoming.version}`;
      if (this.applied.has(dedupeKey)) continue;

      incoming = {
        ...incoming,
        provenance: { ...incoming.provenance, trust: trustAfterSync(incoming.provenance.trust) },
      };

      const existing = byEntity.get(`${incoming.entityType}:${incoming.entityId}`);
      if (existing && existing.version > incoming.version) {
        conflicts.push({
          entityId: incoming.entityId,
          kind: conflictKindFor(incoming.entityType),
          resolution: "keep_local",
          reason: `local version ${existing.version} is newer than incoming ${incoming.version}; remote is not applied`,
        });
        continue;
      }
      if (existing && existing.version === incoming.version && JSON.stringify(existing.payload) !== JSON.stringify(incoming.payload)) {
        conflicts.push({
          entityId: incoming.entityId,
          kind: conflictKindFor(incoming.entityType),
          resolution: "keep_both",
          reason: `both devices edited version ${incoming.version} independently. Neither version is discarded.`,
        });
        continue;
      }
      await input.apply(incoming);
      this.applied.add(dedupeKey);
      applied += 1;
    }

    this.checkpoint.cursor = pull.cursor;
    this.checkpoint.lastPullAt = this.now();
    this.checkpoint.lastError = null;
    return {
      pushed,
      pulled,
      applied,
      conflicts,
      withheld,
      rejected,
      offlineReason: null,
      cursor: this.checkpoint.cursor,
    };
  }

  private backoff(attempts: number): string {
    const ms = Math.min(60_000, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
    return new Date(Date.parse(this.now()) + ms).toISOString();
  }
}

export function payloadOf(record: SyncRecord): JsonObject {
  return record.payload;
}
