/**
 * Cloudflare-oriented provider boundary.
 *
 * Intended mapping, when credentials exist:
 *   D1              = metadata / index / control state
 *   R2              = encrypted payload blobs
 *   Durable Objects = per-user / device sync coordination
 *   Queues          = retry-safe background work
 *
 * This implementation is a stub. It never connects, never stores plaintext, and
 * reports requires_credentials. Local operation does not need it.
 */

import type { EncryptedEnvelope } from "./types.ts";
import type {
  CloudAuth,
  CloudPullResult,
  CloudPushResult,
  CloudStatus,
  CloudSyncProvider,
} from "./cloud.ts";

export class CloudflareCloudProvider implements CloudSyncProvider {
  readonly kind = "cloudflare-stub" as const;

  async authenticate(_deviceId: string): Promise<CloudAuth | { ok: false; reason: string }> {
    return { ok: false, reason: "Cloudflare provider requires production credentials that are not present." };
  }

  async registerDevice(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "Cloudflare provider requires production credentials that are not present." };
  }

  async push(_auth: CloudAuth, envelopes: EncryptedEnvelope[]): Promise<CloudPushResult> {
    return {
      accepted: 0,
      duplicate: 0,
      rejected: envelopes.map((item) => ({
        recordId: item.recordId,
        reason: "Cloudflare provider is a stub. Nothing was uploaded.",
      })),
    };
  }

  async pull(): Promise<CloudPullResult> {
    return { envelopes: [], cursor: "0" };
  }

  async getStatus(): Promise<CloudStatus> {
    return {
      kind: "cloudflare-stub",
      connected: false,
      registeredDevices: 0,
      blobCount: 0,
      lastError: "requires_credentials",
      live: false,
    };
  }

  async backup(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "Cloudflare provider requires production credentials that are not present." };
  }

  async restore(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "Cloudflare provider requires production credentials that are not present." };
  }

  async revokeDevice(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "Cloudflare provider requires production credentials that are not present." };
  }

  async disconnect(): Promise<void> {
    return;
  }
}
