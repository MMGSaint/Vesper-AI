/**
 * Syncable-state contracts.
 *
 * Existing memory scopes already decide who can *see* a fact. This layer is a
 * different question: may this *record* leave the device, and in what form?
 *
 * Synchronized data is DATA. It is never an instruction, never a tool call, and
 * never a permission. The permission gate remains the only path to world change.
 */

import type { ContextTrust, JsonObject } from "../types.ts";

export const SYNC_ENTITY_TYPES = [
  "memory",
  "conversation_continuity",
  "decision",
  "procedure",
  "task_summary",
  "workspace",
  "preference",
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/** Anything that would execute, grant, or relax a bound is refused at the record layer. */
export const FORBIDDEN_SYNC_ENTITY_TYPES = ["tool", "instruction", "grant", "capability", "permission"] as const;

export const SYNC_OPERATIONS = ["create", "update", "delete", "supersede", "archive"] as const;
export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

/**
 * Privacy class. Independent of memory scope so a user-scoped fact can still be
 * marked PRIVATE and stay on this machine.
 *
 *   private      — never leaves the device. Default for personal memory.
 *   device_only  — belongs to one node; other nodes may *see an attribution*, not a copy.
 *   shared       — eligible for encrypted cross-device sync.
 *   global       — intended to exist on every trusted node (assistant/system state).
 */
export const PRIVACY_CLASSES = ["private", "device_only", "shared", "global"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const MEMORY_CURRENCIES = ["current", "superseded", "disputed", "archived", "unknown"] as const;
export type MemoryCurrency = (typeof MEMORY_CURRENCIES)[number];

export const CONTINUITY_TRUSTS = [
  "user",
  "trusted_local",
  "system",
  "synced_user_data",
  "untrusted_external",
] as const;
export type ContinuityTrust = (typeof CONTINUITY_TRUSTS)[number];

export function continuityTrustFromContext(trust: ContextTrust): ContinuityTrust {
  return trust;
}

/**
 * Cloud arrival authenticates origin and integrity. It does not upgrade trust.
 * A synchronised web page stays untrusted_external. A synchronised user fact
 * becomes synced_user_data, never trusted_local.
 */
export function trustAfterSync(trust: ContinuityTrust): ContinuityTrust {
  if (trust === "untrusted_external") return "untrusted_external";
  if (trust === "system") return "system";
  if (trust === "user" || trust === "trusted_local" || trust === "synced_user_data") {
    return "synced_user_data";
  }
  return "untrusted_external";
}

export const MAX_SYNC_PAYLOAD_BYTES = 256 * 1024;
export const MAX_SYNC_RECORDS_PER_PUSH = 200;

export interface SyncProvenance {
  trust: ContinuityTrust;
  sourceDeviceId: string;
  origin: string;
  capturedAt: string;
}

export interface IntegrityMeta {
  /** SHA-256 of the canonical payload, hex. */
  payloadHash: string;
  keyVersion: number;
}

export interface SyncRecord {
  recordId: string;
  entityType: SyncEntityType;
  entityId: string;
  version: number;
  sourceDeviceId: string;
  createdAt: string;
  updatedAt: string;
  operation: SyncOperation;
  payload: JsonObject;
  provenance: SyncProvenance;
  privacy: PrivacyClass;
  integrity: IntegrityMeta;
}

export interface EncryptedEnvelope {
  version: 1;
  recordId: string;
  entityType: SyncEntityType;
  sourceDeviceId: string;
  keyVersion: number;
  /** AES-GCM nonce, base64. */
  nonce: string;
  /** Ciphertext, base64. */
  ciphertext: string;
  /** GCM tag, base64. */
  tag: string;
  /** Bound additional data (recordId|sourceDeviceId|keyVersion), utf8. */
  aad: string;
}

export const CLOUD_PROVIDER_KINDS = ["none", "local-mock", "cloudflare-stub", "live"] as const;
export type CloudProviderKind = (typeof CLOUD_PROVIDER_KINDS)[number];
