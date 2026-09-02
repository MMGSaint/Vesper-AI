/**
 * Background sync vs heartbeat vs agent action.
 *
 * SYNC        = move state. Quiet, bounded, restart-safe. Never wakes the model.
 * HEARTBEAT   = inspect whether something meaningful needs attention.
 * AGENT ACTION = execute an actual task through the existing loop.
 *
 * These remain separate. A successful sync is not a reason to run inference.
 */

import type { CloudAuth, CloudSyncProvider } from "./cloud.ts";
import type { Keyring } from "./crypto.ts";
import type { ContinuityEngine, ExchangeOutcome, InboxApply } from "./engine.ts";
import type { SyncRecord } from "./types.ts";

export interface SyncTickResult {
  ran: boolean;
  wokeModel: false;
  outcome: ExchangeOutcome | null;
  reason: string;
}

export async function runQuietSyncTick(input: {
  enabled: boolean;
  engine: ContinuityEngine;
  provider: CloudSyncProvider;
  auth: CloudAuth | null;
  ring: Keyring;
  local: SyncRecord[];
  apply: InboxApply;
  senderRevoked?: (deviceId: string) => boolean;
}): Promise<SyncTickResult> {
  if (!input.enabled) {
    return { ran: false, wokeModel: false, outcome: null, reason: "sync is disabled" };
  }
  if (!input.auth) {
    return { ran: false, wokeModel: false, outcome: null, reason: "not authenticated" };
  }
  const status = await input.provider.getStatus();
  if (!status.connected) {
    return { ran: false, wokeModel: false, outcome: null, reason: "provider disconnected; local queue preserved" };
  }
  const outcome = await input.engine.exchange({
    provider: input.provider,
    auth: input.auth,
    ring: input.ring,
    local: input.local,
    apply: input.apply,
    senderRevoked: input.senderRevoked,
  });
  return { ran: true, wokeModel: false, outcome, reason: outcome.offlineReason ?? "ok" };
}
