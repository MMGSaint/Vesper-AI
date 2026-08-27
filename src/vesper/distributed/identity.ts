/**
 * Device identity.
 *
 * Every Vesper installation gets a stable, locally generated identity backed by an
 * ed25519 keypair. Hardware serials are deliberately not used: they are readable by any
 * process on the machine and trivially forged by anything that can talk to the sync
 * layer, so they identify a machine but authenticate nothing.
 *
 * The private key is the one secret that must never leave the device. It is never
 * synced, never logged, never exported, and never included in a capability manifest or
 * diagnostics report. Everything a peer needs is the public key.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonObject } from "../types.ts";

export const DEVICE_TYPES = ["desktop", "laptop", "phone", "server", "unknown"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Trust is a state machine, not a boolean. `revoked` is terminal for a given identity:
 * a revoked device that reconnects must not be silently restored to `trusted`, which is
 * the whole point of revoking it.
 *
 * `restricted` is the portable class. A Vesper running from removable media on somebody
 * else's computer is the user's Vesper, but the machine under it is not the user's
 * machine: it may observe memory, files, the clipboard and the network. A restricted
 * device therefore authenticates as the user and still gets materially fewer powers
 * than an installed desktop - it can converse, sync a scoped subset, see presence, and
 * *ask* a trusted device to act, but it never holds host authority itself.
 */
export const TRUST_STATES = ["unknown", "pending", "restricted", "trusted", "revoked"] as const;
export type TrustState = (typeof TRUST_STATES)[number];

/**
 * How much the machine underneath this Vesper is trusted, which is a separate question
 * from how much the *device identity* is trusted. An owned laptop running a trusted
 * Vesper is `owned`; the same Vesper booted from a USB stick in an internet cafe is
 * `foreign`, and must assume the host can observe everything it does.
 */
export const HOST_POSTURES = ["owned", "foreign"] as const;
export type HostPosture = (typeof HOST_POSTURES)[number];

export interface PublicDeviceIdentity {
  deviceId: string;
  deviceType: DeviceType;
  name: string;
  os: string;
  /** ed25519 public key, base64 SPKI. Safe to share; it is how peers verify signatures. */
  publicKey: string;
  createdAt: string;
  vesperVersion: string;
}

export interface DeviceIdentity extends PublicDeviceIdentity {
  /** Sign a payload as this device. The private key never leaves this closure. */
  sign(payload: string): string;
  /** The public half only. Use this anywhere an identity is transmitted or stored. */
  publicIdentity(): PublicDeviceIdentity;
}

interface StoredIdentity {
  deviceId: string;
  deviceType: DeviceType;
  name: string;
  os: string;
  createdAt: string;
  vesperVersion: string;
  publicKey: string;
  privateKey: string;
}

export function identityFile(dirs: { data: string }): string {
  return join(dirs.data, "device-identity.json");
}

function canonical(payload: string): Buffer {
  return Buffer.from(payload, "utf8");
}

/**
 * Stable ordering so two devices signing "the same" object produce the same bytes.
 * Signature verification is meaningless if serialization is ambiguous.
 */
export function canonicalJson(value: JsonObject): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      // A null-prototype object, so an own `__proto__` key is *copied* rather than
      // silently setting the prototype and vanishing. On a plain `{}` it disappeared
      // from the canonical form, which means it was outside the signature: a signed
      // grant could be augmented with content nobody signed. `JSON.stringify` treats a
      // null-prototype object exactly like a plain one.
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        const item = (input as Record<string, unknown>)[key];
        if (item !== undefined) out[key] = walk(item);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

function build(stored: StoredIdentity): DeviceIdentity {
  const privateKey = createPrivateKey({
    key: Buffer.from(stored.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicIdentity = (): PublicDeviceIdentity => ({
    deviceId: stored.deviceId,
    deviceType: stored.deviceType,
    name: stored.name,
    os: stored.os,
    publicKey: stored.publicKey,
    createdAt: stored.createdAt,
    vesperVersion: stored.vesperVersion,
  });
  return {
    ...publicIdentity(),
    sign: (payload: string) => sign(null, canonical(payload), privateKey).toString("base64"),
    publicIdentity,
  };
}

export function verifySignature(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, canonical(payload), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    // A malformed key or signature is a failed verification, never an exception that
    // takes down whatever was checking it.
    return false;
  }
}

/** Constant-time compare for device ids and tokens, so equality cannot be timed. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface LoadIdentityInput {
  dirs: { data: string };
  deviceType?: DeviceType;
  name?: string;
  os?: string;
  vesperVersion: string;
  /** Injected for tests; defaults to the real filesystem. */
  io?: {
    read: (path: string) => Promise<string>;
    write: (path: string, contents: string) => Promise<void>;
  };
}

/**
 * Load this device's identity, generating one on first run.
 *
 * A corrupted or unreadable identity file is replaced rather than fatal, and the fact is
 * reported: a device that cannot identify itself must still be able to run locally, it
 * just has to re-enrol before it can sync again.
 */
export async function loadDeviceIdentity(
  input: LoadIdentityInput,
): Promise<{ identity: DeviceIdentity; created: boolean; note: string | null }> {
  const path = identityFile(input.dirs);
  const io = input.io ?? {
    read: (target: string) => readFile(target, "utf8"),
    write: async (target: string, contents: string) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
      // Best effort: POSIX honours this, Windows ACLs ignore mode bits.
      await chmod(target, 0o600).catch(() => undefined);
    },
  };

  let note: string | null = null;
  try {
    const raw = await io.read(path);
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    if (
      typeof parsed.deviceId === "string" &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string" &&
      parsed.deviceId.length > 0
    ) {
      const stored: StoredIdentity = {
        deviceId: parsed.deviceId,
        deviceType: (DEVICE_TYPES as readonly string[]).includes(parsed.deviceType ?? "")
          ? (parsed.deviceType as DeviceType)
          : "unknown",
        name: parsed.name ?? input.name ?? parsed.deviceId,
        os: parsed.os ?? input.os ?? process.platform,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        vesperVersion: input.vesperVersion,
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
      };
      const identity = build(stored);
      // Prove the stored pair actually works before trusting it for sync.
      const probe = "vesper-identity-selftest";
      if (verifySignature(stored.publicKey, probe, identity.sign(probe))) {
        return { identity, created: false, note: null };
      }
      note = "The stored device key did not verify against itself; a new identity was generated.";
    } else {
      note = "The device identity file was incomplete; a new identity was generated.";
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      note = "The device identity file could not be read; a new identity was generated.";
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const stored: StoredIdentity = {
    deviceId: `dev_${randomUUID()}`,
    deviceType: input.deviceType ?? "unknown",
    name: input.name ?? `vesper-${process.platform}`,
    os: input.os ?? process.platform,
    createdAt: new Date().toISOString(),
    vesperVersion: input.vesperVersion,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
  await io.write(path, `${JSON.stringify(stored, null, 2)}\n`);
  return { identity: build(stored), created: true, note };
}
