/**
 * User-owned backup / export / restore.
 *
 * Independent of the cloud provider. Versioned, integrity-checked, optionally
 * encrypted. This is the escape hatch if the provider changes.
 *
 * Device private keys are NOT included unless the caller passes includeSecrets.
 * Default export is the shared state a person would want on another machine,
 * not the identity of this one.
 */

import { canonicalJson } from "../distributed/identity.ts";
import type { JsonObject, JsonValue } from "../types.ts";
import { encryptEnvelope, decryptEnvelope, sha256Hex, type Keyring } from "./crypto.ts";
import type { EncryptedEnvelope } from "./types.ts";

export const BACKUP_VERSION = 1 as const;

export interface BackupBundle {
  version: typeof BACKUP_VERSION;
  createdAt: string;
  sourceDeviceId: string;
  includesSecrets: boolean;
  integrity: { hash: string };
  state: JsonObject;
  envelope?: EncryptedEnvelope;
}

export interface RestoreResult {
  ok: boolean;
  reason?: string;
  state?: JsonObject;
}

export function exportState(input: {
  state: JsonObject;
  sourceDeviceId: string;
  includeSecrets?: boolean;
  ring?: Keyring;
  now?: () => Date;
}): BackupBundle {
  const state = input.includeSecrets ? input.state : stripSecrets(input.state);
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const hash = sha256Hex(canonicalJson(state));
  const bundle: BackupBundle = {
    version: BACKUP_VERSION,
    createdAt,
    sourceDeviceId: input.sourceDeviceId,
    includesSecrets: Boolean(input.includeSecrets),
    integrity: { hash },
    state,
  };
  if (input.ring) {
    bundle.envelope = encryptEnvelope({
      recordId: `backup:${hash.slice(0, 12)}`,
      entityType: "workspace",
      sourceDeviceId: input.sourceDeviceId,
      plaintext: canonicalJson(state),
      ring: input.ring,
    });
    bundle.state = {};
  }
  return bundle;
}

export function importState(bundle: BackupBundle, ring?: Keyring): RestoreResult {
  if (bundle.version !== BACKUP_VERSION) {
    return { ok: false, reason: `unsupported backup version ${bundle.version}` };
  }
  let state = bundle.state;
  if (bundle.envelope) {
    if (!ring) return { ok: false, reason: "encrypted backup requires a keyring" };
    const decrypted = decryptEnvelope(bundle.envelope, ring);
    if (!decrypted.ok) return { ok: false, reason: decrypted.reason };
    try {
      state = JSON.parse(decrypted.plaintext.toString("utf8")) as JsonObject;
    } catch {
      return { ok: false, reason: "backup payload is not JSON" };
    }
  }
  const hash = sha256Hex(canonicalJson(state));
  if (hash !== bundle.integrity.hash) {
    return { ok: false, reason: "integrity check failed" };
  }
  return { ok: true, state };
}

export const backupState = exportState;
export const restoreState = importState;

const SECRETISH = /(pass(word)?|secret|token|private[_-]?key|api[_-]?key|credential)/i;

function stripSecrets(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [child, item] of Object.entries(value)) {
    out[child] = stripValue(item, child);
  }
  return out;
}

function stripValue(value: JsonValue, key = ""): JsonValue {
  if (SECRETISH.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => stripValue(item));
  if (value && typeof value === "object") {
    return stripSecrets(value);
  }
  return value;
}
