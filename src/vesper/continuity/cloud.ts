/**
 * Provider-neutral cloud contract.
 *
 * The first implementation is a deterministic in-memory mock. The shape is the one a
 * later Cloudflare (or other) backend would implement: authenticated device
 * registration, encrypted blobs, checkpoints, revocation, conflict retrieval.
 *
 * The mock never stores plaintext. A caller that dumps the cloud sees envelopes.
 */

import type { EncryptedEnvelope } from "./types.ts";
import type { CloudProviderKind } from "./types.ts";

export interface CloudAuth {
  deviceId: string;
  token: string;
}

export interface CloudPushResult {
  accepted: number;
  duplicate: number;
  rejected: { recordId: string; reason: string }[];
}

export interface CloudPullResult {
  envelopes: EncryptedEnvelope[];
  cursor: string;
}

export interface CloudStatus {
  kind: CloudProviderKind;
  connected: boolean;
  registeredDevices: number;
  blobCount: number;
  lastError: string | null;
  live: boolean;
}

export interface CloudSyncProvider {
  kind: CloudProviderKind;
  authenticate(deviceId: string): Promise<CloudAuth | { ok: false; reason: string }>;
  registerDevice(auth: CloudAuth, publicKey: string): Promise<{ ok: boolean; reason?: string }>;
  push(auth: CloudAuth, envelopes: EncryptedEnvelope[]): Promise<CloudPushResult>;
  pull(auth: CloudAuth, cursor: string | null): Promise<CloudPullResult>;
  getStatus(): Promise<CloudStatus>;
  revokeDevice(auth: CloudAuth, deviceId: string): Promise<{ ok: boolean; reason?: string }>;
  disconnect(): Promise<void>;
}

const MAX_BLOBS = 4000;

export class MemoryCloudProvider implements CloudSyncProvider {
  readonly kind: CloudProviderKind = "local-mock";
  private readonly tokens = new Map<string, string>();
  private readonly publicKeys = new Map<string, string>();
  private readonly revoked = new Set<string>();
  private readonly blobs: EncryptedEnvelope[] = [];
  private readonly seen = new Set<string>();
  private connected = true;
  private lastError: string | null = null;
  private seq = 0;

  /** Test hook: take the cloud offline without dropping stored blobs. */
  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  /** Inspection only: the mock's stored representation, which must stay encrypted. */
  inspectBlobs(): EncryptedEnvelope[] {
    return this.blobs.map((blob) => ({ ...blob }));
  }

  async authenticate(deviceId: string): Promise<CloudAuth | { ok: false; reason: string }> {
    if (!this.connected) return { ok: false, reason: "cloud unreachable" };
    if (this.revoked.has(deviceId)) return { ok: false, reason: "device is revoked" };
    const existing = this.tokens.get(deviceId);
    if (existing) return { deviceId, token: existing };
    const token = `tok_${deviceId}_${++this.seq}`;
    this.tokens.set(deviceId, token);
    return { deviceId, token };
  }

  async registerDevice(auth: CloudAuth, publicKey: string): Promise<{ ok: boolean; reason?: string }> {
    const gate = this.gate(auth);
    if (!gate.ok) return gate;
    if (this.revoked.has(auth.deviceId)) return { ok: false, reason: "device is revoked" };
    const held = this.publicKeys.get(auth.deviceId);
    if (held && held !== publicKey) {
      return { ok: false, reason: "device presented a different key than the one it registered with" };
    }
    this.publicKeys.set(auth.deviceId, publicKey);
    return { ok: true };
  }

  async push(auth: CloudAuth, envelopes: EncryptedEnvelope[]): Promise<CloudPushResult> {
    if (!this.connected) {
      this.lastError = "cloud unreachable";
      throw new Error("cloud unreachable");
    }
    const gate = this.gate(auth);
    if (!gate.ok) {
      this.lastError = gate.reason ?? "auth failed";
      return { accepted: 0, duplicate: 0, rejected: envelopes.map((item) => ({ recordId: item.recordId, reason: this.lastError! })) };
    }
    let accepted = 0;
    let duplicate = 0;
    const rejected: { recordId: string; reason: string }[] = [];
    for (const envelope of envelopes) {
      if (this.revoked.has(envelope.sourceDeviceId)) {
        rejected.push({ recordId: envelope.recordId, reason: "source device is revoked" });
        continue;
      }
      if (envelope.sourceDeviceId !== auth.deviceId) {
        rejected.push({ recordId: envelope.recordId, reason: "cannot push on behalf of another device" });
        continue;
      }
      if (!envelope.ciphertext || !envelope.tag || !envelope.nonce) {
        rejected.push({ recordId: envelope.recordId, reason: "malformed envelope" });
        continue;
      }
      const key = `${envelope.recordId}:${envelope.keyVersion}`;
      if (this.seen.has(key)) {
        duplicate += 1;
        continue;
      }
      if (this.blobs.length >= MAX_BLOBS) {
        rejected.push({ recordId: envelope.recordId, reason: "cloud store is full" });
        continue;
      }
      this.seen.add(key);
      this.blobs.push({ ...envelope });
      accepted += 1;
    }
    return { accepted, duplicate, rejected };
  }

  async pull(auth: CloudAuth, cursor: string | null): Promise<CloudPullResult> {
    if (!this.connected) {
      this.lastError = "cloud unreachable";
      throw new Error("cloud unreachable");
    }
    const gate = this.gate(auth);
    if (!gate.ok) {
      this.lastError = gate.reason ?? "auth failed";
      return { envelopes: [], cursor: cursor ?? "0" };
    }
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const offset = Number.isFinite(start) && start > 0 ? start : 0;
    const slice = this.blobs.slice(offset).filter((blob) => blob.sourceDeviceId !== auth.deviceId);
    return { envelopes: slice.map((blob) => ({ ...blob })), cursor: String(this.blobs.length) };
  }

  async getStatus(): Promise<CloudStatus> {
    return {
      kind: "local-mock",
      connected: this.connected,
      registeredDevices: this.publicKeys.size,
      blobCount: this.blobs.length,
      lastError: this.lastError,
      live: false,
    };
  }

  async revokeDevice(auth: CloudAuth, deviceId: string): Promise<{ ok: boolean; reason?: string }> {
    const gate = this.gate(auth);
    if (!gate.ok) return gate;
    this.revoked.add(deviceId);
    this.tokens.delete(deviceId);
    return { ok: true };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  private gate(auth: CloudAuth): { ok: true } | { ok: false; reason: string } {
    if (!this.connected) return { ok: false, reason: "cloud unreachable" };
    if (this.revoked.has(auth.deviceId)) return { ok: false, reason: "device is revoked" };
    const token = this.tokens.get(auth.deviceId);
    if (!token || token !== auth.token) return { ok: false, reason: "authentication failed" };
    return { ok: true };
  }
}

export class DisabledCloudProvider implements CloudSyncProvider {
  readonly kind: CloudProviderKind = "none";
  async authenticate(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "cloud sync is disabled" };
  }
  async registerDevice(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "cloud sync is disabled" };
  }
  async push(): Promise<CloudPushResult> {
    return { accepted: 0, duplicate: 0, rejected: [] };
  }
  async pull(): Promise<CloudPullResult> {
    return { envelopes: [], cursor: "0" };
  }
  async getStatus(): Promise<CloudStatus> {
    return {
      kind: "none",
      connected: false,
      registeredDevices: 0,
      blobCount: 0,
      lastError: null,
      live: false,
    };
  }
  async revokeDevice(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "cloud sync is disabled" };
  }
  async disconnect(): Promise<void> {}
}
