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
import type { EncryptedEnvelope, SyncEntityType } from "./types.ts";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const NONCE_LEN = 12;
const HKDF_SALT = Buffer.from("vesper-continuity-v1");

export interface Keyring {
  /** Root/user key. Never leaves this process except via an explicit backup. */
  rootKey: Buffer;
  keyVersion: number;
  /** Device ids that may no longer unwrap envelopes. */
  revokedDeviceIds: Set<string>;
}

export function createKeyring(options?: { rootKey?: Buffer; keyVersion?: number }): Keyring {
  return {
    rootKey: options?.rootKey ?? randomBytes(KEY_LEN),
    keyVersion: options?.keyVersion ?? 1,
    revokedDeviceIds: new Set(),
  };
}

export function rotateKeyring(current: Keyring): Keyring {
  return {
    rootKey: randomBytes(KEY_LEN),
    keyVersion: current.keyVersion + 1,
    revokedDeviceIds: new Set(current.revokedDeviceIds),
  };
}

export function revokeDevice(ring: Keyring, deviceId: string): void {
  ring.revokedDeviceIds.add(deviceId);
}

export function deriveDeviceKey(ring: Keyring, deviceId: string, keyVersion = ring.keyVersion): Buffer {
  return Buffer.from(
    hkdfSync("sha256", ring.rootKey, HKDF_SALT, Buffer.from(`device:${deviceId}:v${keyVersion}`), KEY_LEN),
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
