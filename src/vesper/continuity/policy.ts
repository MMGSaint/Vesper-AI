/**
 * Sync/privacy policy.
 *
 * Default personal memory does NOT become globally synced merely because sync is on.
 * The engine enforces this in code, not as a comment.
 *
 * Demoting SHARED/GLOBAL → PRIVATE/DEVICE_ONLY produces a retraction plan so remote
 * copies do not survive indefinitely. The local copy stays intact.
 */

import { looksLikeSecretValue } from "../security.ts";
import type { PrivacyClass, SyncOperation, SyncRecord } from "./types.ts";
import { FORBIDDEN_SYNC_ENTITY_TYPES, MAX_SYNC_PAYLOAD_BYTES } from "./types.ts";

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key)/i;

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export function defaultPrivacyFor(kind: "personal" | "device" | "system"): PrivacyClass {
  if (kind === "personal") return "private";
  if (kind === "device") return "device_only";
  return "global";
}

export function mayLeaveDevice(privacy: PrivacyClass): boolean {
  return privacy === "shared" || privacy === "global";
}

export function mayEnterCloud(record: SyncRecord): PolicyDecision {
  if ((FORBIDDEN_SYNC_ENTITY_TYPES as readonly string[]).includes(record.entityType)) {
    return { allowed: false, reason: "synchronized data is never an instruction or grant" };
  }
  if (record.operation === "delete" && record.payload.retract === true) {
    const encoded = JSON.stringify(record.payload);
    if (encoded.length > MAX_SYNC_PAYLOAD_BYTES) {
      return { allowed: false, reason: `payload is ${encoded.length} bytes; the cap is ${MAX_SYNC_PAYLOAD_BYTES}` };
    }
    return { allowed: true, reason: "retraction tombstone may leave the device" };
  }
  if (!mayLeaveDevice(record.privacy)) {
    return { allowed: false, reason: `privacy '${record.privacy}' never leaves the device` };
  }
  const encoded = JSON.stringify(record.payload);
  if (encoded.length > MAX_SYNC_PAYLOAD_BYTES) {
    return { allowed: false, reason: `payload is ${encoded.length} bytes; the cap is ${MAX_SYNC_PAYLOAD_BYTES}` };
  }
  if (SECRET_KEY.test(encoded) || looksLikeSecretValue(encoded)) {
    return { allowed: false, reason: "payload looks like a credential" };
  }
  return { allowed: true, reason: "eligible for encrypted sync" };
}

export function mayApplyIncoming(input: {
  record: SyncRecord;
  localDeviceId: string;
  senderRevoked: boolean;
  senderSuspended?: boolean;
}): PolicyDecision {
  if (input.senderRevoked) {
    return { allowed: false, reason: "revoked devices cannot sync" };
  }
  if (input.senderSuspended) {
    return { allowed: false, reason: "suspended devices cannot sync" };
  }
  if ((FORBIDDEN_SYNC_ENTITY_TYPES as readonly string[]).includes(input.record.entityType)) {
    return { allowed: false, reason: "incoming instruction/grant refused" };
  }
  const encoded = JSON.stringify(input.record.payload ?? {});
  if (encoded.length > MAX_SYNC_PAYLOAD_BYTES) {
    return { allowed: false, reason: `incoming payload is ${encoded.length} bytes; the cap is ${MAX_SYNC_PAYLOAD_BYTES}` };
  }
  if (input.record.privacy === "private" && input.record.operation !== "delete") {
    return { allowed: false, reason: "private records must not arrive from the cloud" };
  }
  if (input.record.privacy === "device_only" && input.record.sourceDeviceId !== input.localDeviceId) {
    return { allowed: false, reason: "device-only records belong to their source node" };
  }
  return { allowed: true, reason: "admissible" };
}

export const CONFLICT_KINDS = ["append_only", "mergeable", "current_value", "special"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export function conflictKindFor(entityType: string): ConflictKind {
  if (entityType === "decision" || entityType === "task_summary") return "append_only";
  if (entityType === "preference" || entityType === "workspace") return "mergeable";
  if (entityType === "memory") return "current_value";
  return "special";
}

export interface RetractionPlan {
  entityId: string;
  from: PrivacyClass;
  to: PrivacyClass;
  action: "noop" | "local_only" | "tombstone_remote";
  reason: string;
  operation: SyncOperation;
  /** Tombstone payload carries the id, never the private value. */
  payload: { retract: true; entityId: string; from: PrivacyClass; to: PrivacyClass };
}

export function planDemotion(input: {
  entityId: string;
  from: PrivacyClass;
  to: PrivacyClass;
}): RetractionPlan {
  const payload = { retract: true as const, entityId: input.entityId, from: input.from, to: input.to };
  if (input.from === input.to) {
    return {
      entityId: input.entityId,
      from: input.from,
      to: input.to,
      action: "noop",
      reason: "privacy did not change",
      operation: "update",
      payload,
    };
  }
  const wasShared = mayLeaveDevice(input.from);
  const staysShared = mayLeaveDevice(input.to);
  if (wasShared && !staysShared) {
    return {
      entityId: input.entityId,
      from: input.from,
      to: input.to,
      action: "tombstone_remote",
      reason: "Remote copies must be dropped; the local copy stays.",
      operation: "delete",
      payload,
    };
  }
  return {
    entityId: input.entityId,
    from: input.from,
    to: input.to,
    action: "local_only",
    reason: staysShared ? "Still eligible for sync under the new class." : "Never left the device.",
    operation: "update",
    payload,
  };
}
