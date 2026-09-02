/**
 * Vesper identity — one assistant, many device bodies.
 *
 * DeviceIdentity remains the per-node ed25519 keypair. This object is the user-level
 * identity those devices attach to. It does not replace the device key and it never
 * holds a private key.
 */

import { createId, nowIso } from "../id.ts";
import type { StorageAdapter } from "../storage.ts";
import type { JsonObject, JsonValue } from "../types.ts";
import type { PrivacyClass } from "./types.ts";

const KEY = "continuity.vesper-identity";

export const VESPER_IDENTITY_STATUSES = ["active", "paused", "retired"] as const;
export type VesperIdentityStatus = (typeof VESPER_IDENTITY_STATUSES)[number];

export interface SyncPolicy {
  defaultPrivacy: PrivacyClass;
  /** The cloud is never required for local work. */
  cloudRequired: false;
}

export interface VesperIdentityRecord {
  identityId: string;
  createdAt: string;
  keyVersion: number;
  syncPolicy: SyncPolicy;
  status: VesperIdentityStatus;
  /** Device ids that belong to this assistant. */
  deviceIds: string[];
}

export class VesperIdentityStore {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private record: VesperIdentityRecord | null = null;
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
    const raw = await this.storage.get(KEY);
    this.record = coerceIdentity(raw);
  }

  private async persist(): Promise<void> {
    if (this.record) await this.storage.set(KEY, this.record as unknown as JsonValue);
  }

  async getOrCreate(seedDeviceId: string): Promise<VesperIdentityRecord> {
    return this.run(async () => {
      await this.load();
      if (!this.record) {
        const now = nowIso();
        this.record = {
          identityId: createId("vesper"),
          createdAt: now,
          keyVersion: 1,
          syncPolicy: { defaultPrivacy: "private", cloudRequired: false },
          status: "active",
          deviceIds: [seedDeviceId],
        };
        await this.persist();
      } else if (!this.record.deviceIds.includes(seedDeviceId)) {
        this.record = { ...this.record, deviceIds: [...this.record.deviceIds, seedDeviceId] };
        await this.persist();
      }
      return snapshot(this.record);
    });
  }

  async attachDevice(deviceId: string): Promise<VesperIdentityRecord> {
    return this.run(async () => {
      await this.load();
      if (!this.record) throw new Error("No Vesper identity exists yet.");
      if (!this.record.deviceIds.includes(deviceId)) {
        this.record = { ...this.record, deviceIds: [...this.record.deviceIds, deviceId] };
        await this.persist();
      }
      return snapshot(this.record);
    });
  }

  async detachDevice(deviceId: string): Promise<VesperIdentityRecord> {
    return this.run(async () => {
      await this.load();
      if (!this.record) throw new Error("No Vesper identity exists yet.");
      this.record = { ...this.record, deviceIds: this.record.deviceIds.filter((id) => id !== deviceId) };
      await this.persist();
      return snapshot(this.record);
    });
  }

  async setKeyVersion(keyVersion: number): Promise<VesperIdentityRecord> {
    return this.run(async () => {
      await this.load();
      if (!this.record) throw new Error("No Vesper identity exists yet.");
      this.record = { ...this.record, keyVersion };
      await this.persist();
      return snapshot(this.record);
    });
  }

  async get(): Promise<VesperIdentityRecord | null> {
    await this.load();
    return this.record ? snapshot(this.record) : null;
  }
}

function snapshot(record: VesperIdentityRecord): VesperIdentityRecord {
  return {
    ...record,
    syncPolicy: { ...record.syncPolicy },
    deviceIds: [...record.deviceIds],
  };
}

function coerceIdentity(raw: unknown): VesperIdentityRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.identityId !== "string" || typeof rec.createdAt !== "string") return null;
  const status = VESPER_IDENTITY_STATUSES.includes(rec.status as VesperIdentityStatus)
    ? (rec.status as VesperIdentityStatus)
    : "active";
  const privacy =
    rec.syncPolicy && typeof rec.syncPolicy === "object"
      ? ((rec.syncPolicy as JsonObject).defaultPrivacy as PrivacyClass)
      : "private";
  return {
    identityId: rec.identityId,
    createdAt: rec.createdAt,
    keyVersion: typeof rec.keyVersion === "number" ? rec.keyVersion : 1,
    syncPolicy: {
      defaultPrivacy: ["private", "device_only", "shared", "global"].includes(privacy) ? privacy : "private",
      cloudRequired: false,
    },
    status,
    deviceIds: Array.isArray(rec.deviceIds) ? rec.deviceIds.filter((id): id is string => typeof id === "string") : [],
  };
}
