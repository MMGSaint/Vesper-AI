/**
 * Device registry: who the other Vespers are, whether they are trusted, and whether
 * they are around right now.
 *
 * Trust and presence are deliberately separate. A device being reachable says nothing
 * about whether it may ask this one to do anything, and a trusted device being offline
 * does not make it untrusted. Collapsing the two is how "my phone is on the network"
 * turns into "my phone may drive my desktop".
 */

import type { StorageAdapter } from "../storage.ts";
import type { JsonValue } from "../types.ts";
import {
  DEVICE_TYPES,
  TRUST_STATES,
  safeEqual,
  type DeviceType,
  type PublicDeviceIdentity,
  type TrustState,
} from "./identity.ts";
import type { CapabilityManifest } from "./capabilities.ts";

const KEY = "devices.registry";

export const REACHABILITY = ["online", "offline"] as const;
export type Reachability = (typeof REACHABILITY)[number];

/** What the user is doing on that device, when it is willing to say. */
export const ACTIVITY = ["active", "idle", "background", "unknown"] as const;
export type Activity = (typeof ACTIVITY)[number];

export interface DevicePresence {
  reachability: Reachability;
  activity: Activity;
  lastSeen: string | null;
}

export interface DeviceRecord {
  identity: PublicDeviceIdentity;
  trust: TrustState;
  presence: DevicePresence;
  capabilities: CapabilityManifest | null;
  enrolledAt: string;
  /** Set when trust was revoked. Kept so a re-enrolment attempt is visibly a re-entry. */
  revokedAt: string | null;
}

export interface RegistryOptions {
  storage: StorageAdapter;
  /** This device. It is trusted by construction; it is the one running the code. */
  self: PublicDeviceIdentity;
  now?: () => string;
  /** A device unseen for longer than this is reported offline rather than stale-online. */
  presenceTimeoutMs?: number;
}

export interface EnrolResult {
  ok: boolean;
  record?: DeviceRecord;
  reason?: string;
}

const DEFAULT_PRESENCE_TIMEOUT_MS = 90_000;

function validIdentity(value: unknown): value is PublicDeviceIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === "string" &&
    candidate.deviceId.length > 0 &&
    typeof candidate.publicKey === "string" &&
    candidate.publicKey.length > 0 &&
    (DEVICE_TYPES as readonly string[]).includes(String(candidate.deviceType))
  );
}

export class DeviceRegistry {
  private readonly storage: StorageAdapter;
  private readonly self: PublicDeviceIdentity;
  private readonly now: () => string;
  private readonly presenceTimeoutMs: number;
  private records = new Map<string, DeviceRecord>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RegistryOptions) {
    this.storage = options.storage;
    this.self = options.self;
    this.now = options.now ?? (() => new Date().toISOString());
    this.presenceTimeoutMs = options.presenceTimeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
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
    try {
      const raw = await this.storage.get(KEY);
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const record = item as Partial<DeviceRecord>;
          if (!validIdentity(record.identity)) continue;
          const trust = (TRUST_STATES as readonly string[]).includes(String(record.trust))
            ? (record.trust as TrustState)
            : "unknown";
          this.records.set(record.identity.deviceId, {
            identity: record.identity,
            trust,
            presence: {
              reachability: "offline",
              activity: "unknown",
              lastSeen: typeof record.presence?.lastSeen === "string" ? record.presence.lastSeen : null,
            },
            capabilities: (record.capabilities as CapabilityManifest | null) ?? null,
            enrolledAt: typeof record.enrolledAt === "string" ? record.enrolledAt : this.now(),
            revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
          });
        }
      }
    } catch {
      // A corrupt registry costs knowledge of peers, never the ability to run locally.
      this.records = new Map();
    }
    // This device is always present in its own registry, and always trusted: it is the
    // process making the decisions.
    if (!this.records.has(this.self.deviceId)) {
      this.records.set(this.self.deviceId, {
        identity: this.self,
        trust: "trusted",
        presence: { reachability: "online", activity: "active", lastSeen: this.now() },
        capabilities: null,
        enrolledAt: this.now(),
        revokedAt: null,
      });
    }
  }

  private async persist(): Promise<void> {
    const serialised = [...this.records.values()] as unknown as JsonValue;
    await this.storage.set(KEY, serialised).catch(() => {
      // Losing the write costs peer memory across a restart, not availability now.
    });
  }

  async list(): Promise<DeviceRecord[]> {
    await this.runExclusive(async () => this.load());
    // Derive "now" from the same clock that stamps lastSeen. Reading one from an
    // injected clock and the other from Date.now() makes every peer look stale.
    const nowMs = Date.parse(this.now());
    const cutoff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - this.presenceTimeoutMs;
    return [...this.records.values()].map((record) => {
      if (record.identity.deviceId === this.self.deviceId) return { ...record };
      const seen = record.presence.lastSeen ? Date.parse(record.presence.lastSeen) : NaN;
      // Silence is not presence: an unseen device is reported offline, not last-known.
      const stale = !Number.isFinite(seen) || seen < cutoff;
      return stale
        ? { ...record, presence: { ...record.presence, reachability: "offline", activity: "unknown" } }
        : { ...record };
    });
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return (await this.list()).find((record) => safeEqual(record.identity.deviceId, deviceId));
  }

  /**
   * Enrol a device. New devices land in `pending` and must be trusted explicitly - a
   * device does not become trusted by asking.
   *
   * A previously revoked identity is refused outright. Letting it re-enrol would mean
   * revocation could be undone by reconnecting, which is not revocation at all.
   */
  async enrol(identity: PublicDeviceIdentity): Promise<EnrolResult> {
    return this.runExclusive(async () => {
      await this.load();
      if (!validIdentity(identity)) {
        return { ok: false, reason: "The identity is malformed." };
      }
      const existing = this.records.get(identity.deviceId);
      if (existing?.trust === "revoked") {
        return {
          ok: false,
          reason: `Device ${identity.deviceId} was revoked and cannot re-enrol. Remove it explicitly first.`,
        };
      }
      if (existing) {
        // A key change on a known device id is an impersonation attempt, not a rotation.
        if (!safeEqual(existing.identity.publicKey, identity.publicKey)) {
          return {
            ok: false,
            reason: `Device ${identity.deviceId} presented a different key than the one it enrolled with.`,
          };
        }
        return { ok: true, record: { ...existing } };
      }
      const record: DeviceRecord = {
        identity,
        trust: "pending",
        presence: { reachability: "online", activity: "unknown", lastSeen: this.now() },
        capabilities: null,
        enrolledAt: this.now(),
        revokedAt: null,
      };
      this.records.set(identity.deviceId, record);
      await this.persist();
      return { ok: true, record: { ...record } };
    });
  }

  async setTrust(deviceId: string, trust: Exclude<TrustState, "unknown">): Promise<EnrolResult> {
    return this.runExclusive(async () => {
      await this.load();
      const record = this.records.get(deviceId);
      if (!record) return { ok: false, reason: `No device ${deviceId} is enrolled.` };
      if (record.trust === "revoked" && trust === "trusted") {
        return {
          ok: false,
          reason: `Device ${deviceId} is revoked. Re-trusting requires removing and re-enrolling it deliberately.`,
        };
      }
      record.trust = trust;
      record.revokedAt = trust === "revoked" ? this.now() : record.revokedAt;
      await this.persist();
      return { ok: true, record: { ...record } };
    });
  }

  /** Remove a device entirely. This is the only way back from `revoked`. */
  async forget(deviceId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.load();
      if (safeEqual(deviceId, this.self.deviceId)) return false;
      const removed = this.records.delete(deviceId);
      if (removed) await this.persist();
      return removed;
    });
  }

  /** A heartbeat from a device. Presence never changes trust. */
  async recordPresence(
    deviceId: string,
    presence: { reachability?: Reachability; activity?: Activity },
  ): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.load();
      const record = this.records.get(deviceId);
      if (!record) return false;
      record.presence = {
        reachability: presence.reachability ?? "online",
        activity: presence.activity ?? record.presence.activity,
        lastSeen: this.now(),
      };
      await this.persist();
      return true;
    });
  }

  async setCapabilities(deviceId: string, manifest: CapabilityManifest): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.load();
      const record = this.records.get(deviceId);
      if (!record) return false;
      record.capabilities = manifest;
      await this.persist();
      return true;
    });
  }

  /** Devices allowed to participate in sync and receive routed tasks. */
  async trusted(): Promise<DeviceRecord[]> {
    return (await this.list()).filter((record) => record.trust === "trusted");
  }
}
