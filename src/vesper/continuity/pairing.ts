/**
 * Pairing: a device becomes known, not trusted.
 *
 * Enrolment lands in `pending`. Trust is a separate, explicit act on the DeviceRegistry.
 * A pairing code is short-lived and compared in constant time. This module does not
 * open a network listener; a later transport would carry the offer.
 *
 * Pairing states (this ledger) are independent of DeviceRegistry trust:
 *   pending → trusted → suspended ⇄ trusted
 *   any → revoked (terminal for this pairing)
 *
 * `restricted` on the registry is the portable/USB class. It is not a synonym for
 * suspended. Suspended means the owner paused sync without revoking the device.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createId, nowIso } from "../id.ts";
import type { DeviceRegistry } from "../distributed/registry.ts";
import type { PublicDeviceIdentity } from "../distributed/identity.ts";
import type { StorageAdapter } from "../storage.ts";
import type { JsonValue } from "../types.ts";
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
  ledger?: PairingLedger;
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
  if (input.ledger) await input.ledger.markPending(input.offer.from.deviceId);
  return { ok: true, deviceId: input.offer.from.deviceId };
}

export function pairingStamp(): string {
  return nowIso();
}

export const PAIRING_STATES = ["pending", "trusted", "suspended", "revoked"] as const;
export type PairingState = (typeof PAIRING_STATES)[number];

export interface PairingEntry {
  deviceId: string;
  state: PairingState;
  updatedAt: string;
}

const LEDGER_KEY = "continuity.pairing";

/**
 * Sync admission independent of DeviceRegistry.trust.
 * A suspended device cannot sync. A revoked pairing cannot resume.
 */
export class PairingLedger {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private items = new Map<string, PairingEntry>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await this.storage.get(LEDGER_KEY);
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.deviceId !== "string") continue;
      const state = PAIRING_STATES.includes(rec.state as PairingState) ? (rec.state as PairingState) : "pending";
      this.items.set(rec.deviceId, {
        deviceId: rec.deviceId,
        state,
        updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
      });
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(LEDGER_KEY, [...this.items.values()] as unknown as JsonValue);
  }

  async markPending(deviceId: string): Promise<PairingEntry> {
    return this.set(deviceId, "pending");
  }

  async approve(deviceId: string): Promise<PairingEntry> {
    return this.transition(deviceId, ["pending", "suspended", "trusted"], "trusted");
  }

  async suspend(deviceId: string): Promise<PairingEntry> {
    return this.transition(deviceId, ["trusted"], "suspended");
  }

  async resume(deviceId: string): Promise<PairingEntry> {
    return this.transition(deviceId, ["suspended"], "trusted");
  }

  async revoke(deviceId: string): Promise<PairingEntry> {
    return this.set(deviceId, "revoked");
  }

  async maySync(deviceId: string): Promise<boolean> {
    await this.load();
    const entry = this.items.get(deviceId);
    if (!entry) return true;
    return entry.state === "trusted";
  }

  async get(deviceId: string): Promise<PairingEntry | undefined> {
    await this.load();
    const entry = this.items.get(deviceId);
    return entry ? { ...entry } : undefined;
  }

  async list(): Promise<PairingEntry[]> {
    await this.load();
    return [...this.items.values()].map((item) => ({ ...item }));
  }

  private set(deviceId: string, state: PairingState): Promise<PairingEntry> {
    return this.run(async () => {
      await this.load();
      const existing = this.items.get(deviceId);
      if (existing?.state === "revoked" && state !== "revoked") {
        throw new Error("A revoked pairing cannot be restored. Forget the device and pair again.");
      }
      const entry: PairingEntry = { deviceId, state, updatedAt: nowIso() };
      this.items.set(deviceId, entry);
      await this.persist();
      return { ...entry };
    });
  }

  private transition(deviceId: string, from: PairingState[], to: PairingState): Promise<PairingEntry> {
    return this.run(async () => {
      await this.load();
      const existing = this.items.get(deviceId);
      if (!existing) {
        throw new Error("No pairing for this device.");
      }
      if (existing.state === "revoked") {
        throw new Error("A revoked pairing cannot be restored. Forget the device and pair again.");
      }
      if (existing && !from.includes(existing.state)) {
        throw new Error(`Pairing is ${existing.state}, not ${from.join("/")}.`);
      }
      const entry: PairingEntry = { deviceId, state: to, updatedAt: nowIso() };
      this.items.set(deviceId, entry);
      await this.persist();
      return { ...entry };
    });
  }
}
