/**
 * Envelope encryption for the sync layer.
 *
 * LOCAL PLAINTEXT → AES-256-GCM envelope → cloud blob → verify/decrypt → LOCAL PLAINTEXT
 *
 * This uses audited Node primitives (AES-GCM, HKDF-SHA-256). It is not a claim of
 * production-grade E2EE. Keys never appear in logs. Root material is never written
 * into source-controlled configuration.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { JsonObject } from "../types.ts";
import type { EncryptedEnvelope, SyncEntityType } from "./types.ts";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const NONCE_LEN = 12;
const HKDF_SALT = Buffer.from("vesper-continuity-v1");
const MAX_PREVIOUS_KEYS = 4;

export interface KeyVersion {
  rootKey: Buffer;
  keyVersion: number;
}

export interface Keyring {
  /** Root/user key. Never leaves this process except via an explicit backup. */
  rootKey: Buffer;
  keyVersion: number;
  /** Prior roots, kept so rotation does not orphan existing envelopes. */
  previous: KeyVersion[];
  /** Device ids that may no longer unwrap envelopes. */
  revokedDeviceIds: Set<string>;
}

export function createKeyring(options?: {
  rootKey?: Buffer;
  keyVersion?: number;
  previous?: KeyVersion[];
}): Keyring {
  return {
    rootKey: options?.rootKey ?? randomBytes(KEY_LEN),
    keyVersion: options?.keyVersion ?? 1,
    previous: options?.previous ? options.previous.map((item) => ({ ...item })) : [],
    revokedDeviceIds: new Set(),
  };
}

export function rotateKeyring(current: Keyring): Keyring {
  return {
    rootKey: randomBytes(KEY_LEN),
    keyVersion: current.keyVersion + 1,
    previous: [...current.previous, { rootKey: current.rootKey, keyVersion: current.keyVersion }].slice(
      -MAX_PREVIOUS_KEYS,
    ),
    revokedDeviceIds: new Set(current.revokedDeviceIds),
  };
}

export function revokeDevice(ring: Keyring, deviceId: string): void {
  ring.revokedDeviceIds.add(deviceId);
}

function materialFor(ring: Keyring, keyVersion: number): Buffer | null {
  if (keyVersion === ring.keyVersion) return ring.rootKey;
  const old = ring.previous.find((item) => item.keyVersion === keyVersion);
  return old?.rootKey ?? null;
}

export function deriveDeviceKey(ring: Keyring, deviceId: string, keyVersion = ring.keyVersion): Buffer {
  const material = materialFor(ring, keyVersion);
  if (!material) {
    throw new Error(`No key material for version ${keyVersion}.`);
  }
  return Buffer.from(
    hkdfSync("sha256", material, HKDF_SALT, Buffer.from(`device:${deviceId}:v${keyVersion}`), KEY_LEN),
  );
}

function aadBytes(recordId: string, sourceDeviceId: string, keyVersion: number): Buffer {
  return Buffer.from(`${recordId}|${sourceDeviceId}|${keyVersion}`, "utf8");
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encryptEnvelope(input: {
  recordId: string;
  entityType: SyncEntityType;
  sourceDeviceId: string;
  plaintext: Buffer | string;
  ring: Keyring;
}): EncryptedEnvelope {
  if (input.ring.revokedDeviceIds.has(input.sourceDeviceId)) {
    throw new Error(`Device ${input.sourceDeviceId} is revoked and cannot encrypt.`);
  }
  const key = deriveDeviceKey(input.ring, input.sourceDeviceId);
  const nonce = randomBytes(NONCE_LEN);
  const aad = aadBytes(input.recordId, input.sourceDeviceId, input.ring.keyVersion);
  const cipher = createCipheriv(ALG, key, nonce);
  cipher.setAAD(aad);
  const plain = typeof input.plaintext === "string" ? Buffer.from(input.plaintext, "utf8") : input.plaintext;
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    recordId: input.recordId,
    entityType: input.entityType,
    sourceDeviceId: input.sourceDeviceId,
    keyVersion: input.ring.keyVersion,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    aad: aad.toString("utf8"),
  };
}

export type DecryptResult =
  | { ok: true; plaintext: Buffer }
  | { ok: false; reason: string };

export function decryptEnvelope(envelope: EncryptedEnvelope, ring: Keyring): DecryptResult {
  if (envelope.version !== 1) return { ok: false, reason: `unsupported envelope version ${envelope.version}` };
  if (ring.revokedDeviceIds.has(envelope.sourceDeviceId)) {
    return { ok: false, reason: "source device is revoked" };
  }
  const expectedAad = aadBytes(envelope.recordId, envelope.sourceDeviceId, envelope.keyVersion).toString("utf8");
  if (envelope.aad !== expectedAad) {
    return { ok: false, reason: "aad mismatch" };
  }
  if (!materialFor(ring, envelope.keyVersion)) {
    return { ok: false, reason: `unknown key version ${envelope.keyVersion}` };
  }
  try {
    const key = deriveDeviceKey(ring, envelope.sourceDeviceId, envelope.keyVersion);
    const nonce = Buffer.from(envelope.nonce, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const decipher = createDecipheriv(ALG, key, nonce);
    decipher.setAAD(Buffer.from(envelope.aad, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, plaintext };
  } catch {
    return { ok: false, reason: "authentication failed" };
  }
}

/** Constant-time compare for pairing codes and tokens. */
export function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function randomCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function serializeKeyring(ring: Keyring): JsonObject {
  return {
    keyVersion: ring.keyVersion,
    rootKey: ring.rootKey.toString("base64"),
    previous: ring.previous.map((item) => ({
      keyVersion: item.keyVersion,
      rootKey: item.rootKey.toString("base64"),
    })),
    revokedDeviceIds: [...ring.revokedDeviceIds],
  };
}

export function restoreKeyring(raw: unknown): Keyring | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.rootKey !== "string" || typeof rec.keyVersion !== "number") return null;
  const previous: KeyVersion[] = [];
  if (Array.isArray(rec.previous)) {
    for (const item of rec.previous) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.rootKey === "string" && typeof row.keyVersion === "number") {
        previous.push({ rootKey: Buffer.from(row.rootKey, "base64"), keyVersion: row.keyVersion });
      }
    }
  }
  const ring = createKeyring({
    rootKey: Buffer.from(rec.rootKey, "base64"),
    keyVersion: rec.keyVersion,
    previous,
  });
  if (Array.isArray(rec.revokedDeviceIds)) {
    for (const id of rec.revokedDeviceIds) {
      if (typeof id === "string") ring.revokedDeviceIds.add(id);
    }
  }
  return ring;
}
