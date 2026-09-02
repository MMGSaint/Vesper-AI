/**
 * SyncRecord builder. The record layer refuses to serialise instructions.
 */

import { canonicalJson } from "../distributed/identity.ts";
import { createId, nowIso } from "../id.ts";
import type { JsonObject } from "../types.ts";
import { sha256Hex } from "./crypto.ts";
import {
  FORBIDDEN_SYNC_ENTITY_TYPES,
  MAX_SYNC_PAYLOAD_BYTES,
  type ContinuityTrust,
  type PrivacyClass,
  type SyncEntityType,
  type SyncOperation,
  type SyncRecord,
} from "./types.ts";

export class SyncRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRecordError";
  }
}

export function buildSyncRecord(input: {
  entityType: string;
  entityId: string;
  sourceDeviceId: string;
  operation: SyncOperation;
  payload: JsonObject;
  privacy: PrivacyClass;
  trust: ContinuityTrust;
  origin: string;
  version?: number;
  keyVersion?: number;
  now?: () => Date;
}): SyncRecord {
  if ((FORBIDDEN_SYNC_ENTITY_TYPES as readonly string[]).includes(input.entityType)) {
    throw new SyncRecordError("Synchronized data is never an instruction, grant, or tool.");
  }
  const known: readonly string[] = [
    "memory",
    "conversation_continuity",
    "decision",
    "procedure",
    "task_summary",
    "workspace",
    "preference",
  ];
  if (!known.includes(input.entityType)) {
    throw new SyncRecordError(`Unknown entity type '${input.entityType}'.`);
  }
  const encoded = canonicalJson(input.payload);
  if (encoded.length > MAX_SYNC_PAYLOAD_BYTES) {
    throw new SyncRecordError(`Payload is ${encoded.length} bytes; the cap is ${MAX_SYNC_PAYLOAD_BYTES}.`);
  }
  const stamp = nowIso(input.now);
  return {
    recordId: createId("sync"),
    entityType: input.entityType as SyncEntityType,
    entityId: input.entityId,
    version: Math.max(1, input.version ?? 1),
    sourceDeviceId: input.sourceDeviceId,
    createdAt: stamp,
    updatedAt: stamp,
    operation: input.operation,
    payload: input.payload,
    provenance: {
      trust: input.trust,
      sourceDeviceId: input.sourceDeviceId,
      origin: input.origin,
      capturedAt: stamp,
    },
    privacy: input.privacy,
    integrity: {
      payloadHash: sha256Hex(encoded),
      keyVersion: input.keyVersion ?? 1,
    },
  };
}

export function verifyRecordIntegrity(record: SyncRecord): boolean {
  return record.integrity.payloadHash === sha256Hex(canonicalJson(record.payload));
}
