/**
 * Restart-safe continuity persistence.
 *
 * The engine and keyring used to be constructed fresh every boot, so outbox items
 * and previous key versions vanished. This module is the snapshot. The cloud is
 * still optional; local queues survive a restart even when sync is disabled.
 */

import type { StorageAdapter } from "../storage.ts";
import type { JsonValue } from "../types.ts";
import { ContinuityEngine } from "./engine.ts";
import { restoreKeyring, serializeKeyring, type Keyring } from "./crypto.ts";

const ENGINE_KEY = "continuity.engine";
const RING_KEY = "continuity.keyring";

export async function persistContinuity(
  storage: StorageAdapter,
  engine: ContinuityEngine,
  ring: Keyring,
): Promise<void> {
  const snap = engine.snapshot();
  await storage.set(ENGINE_KEY, snap as unknown as JsonValue);
  await storage.set(RING_KEY, serializeKeyring(ring) as unknown as JsonValue);
}

export async function restoreContinuity(
  storage: StorageAdapter,
  engine: ContinuityEngine,
): Promise<Keyring | null> {
  const snap = await storage.get(ENGINE_KEY);
  if (snap && typeof snap === "object" && !Array.isArray(snap)) {
    const rec = snap as Record<string, unknown>;
    engine.restore({
      outbox: Array.isArray(rec.outbox) ? (rec.outbox as never) : undefined,
      checkpoint: rec.checkpoint && typeof rec.checkpoint === "object" ? (rec.checkpoint as never) : undefined,
      applied: Array.isArray(rec.applied) ? rec.applied.filter((id): id is string => typeof id === "string") : undefined,
    });
  }
  return restoreKeyring(await storage.get(RING_KEY));
}
