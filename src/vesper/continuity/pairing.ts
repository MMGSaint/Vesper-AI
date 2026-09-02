/**
 * Pairing: a device becomes known, not trusted.
 *
 * Enrolment lands in `pending`. Trust is a separate, explicit act on the DeviceRegistry.
 * A pairing code is short-lived and compared in constant time. This module does not
 * open a network listener; a later transport would carry the offer.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createId, nowIso } from "../id.ts";
import type { DeviceRegistry } from "../distributed/registry.ts";
import type { PublicDeviceIdentity } from "../distributed/identity.ts";
import { randomCode } from "./crypto.ts";

export interface PairingOffer {
  offerId: string;
  from: PublicDeviceIdentity;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairingPlaintext {
  offer: PairingOffer;
  /** Shown once to the owner. Never stored. */
  code: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function hashCode(code: string, offerId: string): string {
  return createHash("sha256").update(`${offerId}:${code}`).digest("hex");
}

function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createPairingOffer(input: {
  from: PublicDeviceIdentity;
  ttlMs?: number;
  now?: () => Date;
}): PairingPlaintext {
  const clock = input.now ?? (() => new Date());
  const created = clock();
  const offerId = createId("pair");
  const code = randomCode(6);
  const offer: PairingOffer = {
    offerId,
    from: input.from,
    codeHash: hashCode(code, offerId),
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
  return { offer, code };
}

export async function acceptPairing(input: {
  offer: PairingOffer;
  code: string;
  registry: DeviceRegistry;
  now?: () => Date;
}): Promise<{ ok: true; deviceId: string } | { ok: false; reason: string }> {
  const now = (input.now ?? (() => new Date()))();
  if (Date.parse(input.offer.expiresAt) <= now.getTime()) {
    return { ok: false, reason: "pairing offer expired" };
  }
  const expected = hashCode(input.code.trim().toUpperCase(), input.offer.offerId);
  if (!codesEqual(expected, input.offer.codeHash)) {
    return { ok: false, reason: "pairing code does not match" };
  }
  const enrolled = await input.registry.enrol(input.offer.from);
  if (!enrolled.ok) return { ok: false, reason: enrolled.reason ?? "enrol failed" };
  return { ok: true, deviceId: input.offer.from.deviceId };
}

export function pairingStamp(): string {
  return nowIso();
}
