/**
 * Sync/privacy policy.
 *
 * Default personal memory does NOT become globally synced merely because sync is on.
 * The engine enforces this in code, not as a comment.
 */

import { looksLikeSecretValue } from "../security.ts";
import type { PrivacyClass, SyncRecord } from "./types.ts";
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
}): PolicyDecision {
  if (input.senderRevoked) {
    return { allowed: false, reason: "revoked devices cannot sync" };
  }
  if ((FORBIDDEN_SYNC_ENTITY_TYPES as readonly string[]).includes(input.record.entityType)) {
    return { allowed: false, reason: "incoming instruction/grant refused" };
  }
  if (input.record.privacy === "private") {
    return { allowed: false, reason: "private records must not arrive from the cloud" };
  }
  if (input.record.privacy === "device_only" && input.record.sourceDeviceId !== input.localDeviceId) {
    return { allowed: false, reason: "device-only records belong to their source node" };
  }
  return { allowed: true, reason: "admissible" };
}
