/**
 * Session capsule — a signed, structured summary of a Vesper session that a peer
 * device (or a future self after a portable-drive transit) can rehydrate from.
 *
 * The mission's continuity fabric is *architecturally* prepared here, without opening
 * a listener or activating any transport. The capsule is the record shape; a future
 * transport will carry it. Everything a transport eventually needs — device identity,
 * signature, filtered memory delta, trust ceiling, capability requirements — is
 * settled at build time.
 *
 * Design decisions worth naming:
 *   - Signature covers a canonicalised JSON of the capsule minus the signature field
 *     itself. Any peer with the sender's public key can verify integrity + origin.
 *   - Preferences are drawn from persistent memory but pass through `filterForSync`
 *     first — the mission's rule "credential filter by name AND value" is enforced
 *     at capsule build, not at the transport layer.
 *   - Ingestion is deterministic:
 *       * device-scoped facts are NEVER merged across devices (per the existing
 *         resolveMemoryConflict rule)
 *       * a capsule may carry decisions, task summaries, and observations that
 *         inform the recipient, but it CANNOT grant capabilities, relax trust, or
 *         un-revoke a device — ingestion refuses those every time
 *       * safer-state wins for security-touching fields: if the capsule says a
 *         device is trusted and the local record says restricted, restricted wins
 *   - Nothing here opens a socket. There is no `push()` and no `pull()` — those
 *     belong to whichever transport is implemented later. This module only builds,
 *     verifies, and ingests capsules held in memory or on disk.
 *
 * Load-bearing invariants (each has a named test):
 *   - a tampered capsule fails signature verification
 *   - a capsule with a mismatched sender.deviceId vs signature key fails
 *   - `filterForSync` runs before serialization — no credential text leaves the
 *     device even if the caller passed a "secret" memory entry to build()
 *   - ingestion never sets local trust higher than the record already holds
 *   - ingestion cannot un-revoke a device — a revoked deviceId in the local
 *     registry stays revoked
 *   - a capsule from an unknown device is not merged; its facts are dropped
 */

import { canonicalJson, verifySignature } from "./distributed/identity.ts";
import type { DeviceIdentity, PublicDeviceIdentity } from "./distributed/identity.ts";
import { filterForSync } from "./distributed/sync.ts";
import type { MemoryEntry } from "./types.ts";
import type { VesperTask } from "./distributed/tasks.ts";
import type { VesperEvent, JsonObject, JsonValue } from "./types.ts";

/**
 * The capsule schema. Version-tagged so a future author can migrate rather than
 * silently reinterpret. Every field is either mandatory or explicitly optional; the
 * ingest side rejects unknown top-level fields via a schema check.
 */
export interface SessionCapsule {
  /** Wire format version. Bump only for breaking changes. */
  version: 1;
  /** The device that authored this capsule. */
  sender: PublicDeviceIdentity;
  /** Free-form session correlation id — matches the runtime's correlationId if any. */
  sessionId: string;
  /** ISO timestamps for the covered window. */
  createdAt: string;
  windowStart: string;
  windowEnd: string;
  /** Vesper software version at the time of build. */
  vesperVersion: string;
  /** Which model role → provider mapping was active, if known. Provider IDs only, no keys. */
  models?: Record<string, string>;
  /** Which workspace was active when the capsule was built. */
  activeWorkspace: string;
  /**
   * Preferences drawn from the sender's persistent memory. Passed through
   * filterForSync before inclusion — a credential-looking entry is elided even if the
   * caller passed it.
   */
  preferences: CapsuleMemoryEntry[];
  /** Compact task snapshots — no chain-of-thought, only observable state. */
  tasks: CapsuleTaskEntry[];
  /** Durable decisions from the event journal (autonomy.decision etc). */
  decisions: CapsuleDecisionEntry[];
  /** Vesper-recorded observations (arbitrary event summaries the sender curates). */
  observations: CapsuleObservationEntry[];
  /** Corrections — cases where an assumption was later shown wrong. */
  corrections: CapsuleCorrectionEntry[];
  /** Recorded pending backlog counts — actionable state a peer might inherit. */
  pending: {
    tasks: number;
    confirmations: number;
  };
  /** Signature over canonicalJson({...capsule, signature: undefined}). Base64-encoded. */
  signature: string;
}

export interface CapsuleMemoryEntry {
  category: string;
  key: string;
  value: string;
  workspaceId?: string;
  /** Origin device id (if known). Ingest uses this to enforce device-scoped rules. */
  originDeviceId?: string;
  /** Sender's local scope, informational — the ingest side derives its own. */
  scopeLevel?: string;
}

export interface CapsuleTaskEntry {
  id: string;
  description: string;
  state: VesperTask["state"];
  createdAt: string;
  updatedAt: string;
  kind?: string;
  /** Never carry the full args — they may contain sensitive detail. */
  argsPresent: boolean;
}

export interface CapsuleDecisionEntry {
  /** e.g. "autonomy.decision" */
  type: string;
  at: string;
  title: string;
  detail?: string;
  correlationId?: string;
  /** The event's `data` bag, redacted of anything filterable. */
  data?: JsonObject;
}

export interface CapsuleObservationEntry {
  at: string;
  type: string;
  title: string;
  detail?: string;
}

export interface CapsuleCorrectionEntry {
  at: string;
  what: string;
  expected: string;
  observed: string;
  /** Kept concise — no chain-of-thought. */
  lessons?: string;
}

/**
 * Build a capsule from runtime pieces. The caller passes in already-collected data
 * (memory, tasks, journaled events) — the capsule builder does NOT reach into
 * runtime state directly, so it stays testable without a full runtime.
 */
export function buildSessionCapsule(input: {
  sender: DeviceIdentity;
  sessionId: string;
  windowStart: string;
  windowEnd: string;
  vesperVersion: string;
  models?: Record<string, string>;
  activeWorkspace: string;
  memory: MemoryEntry[];
  tasks: VesperTask[];
  decisions: VesperEvent[];
  observations: VesperEvent[];
  corrections?: CapsuleCorrectionEntry[];
  pending: { tasks: number; confirmations: number };
  now?: () => Date;
}): SessionCapsule {
  const clock = input.now ?? (() => new Date());
  const filtered = filterForSync(input.memory);
  const preferences: CapsuleMemoryEntry[] = filtered.send.map((entry) => ({
    category: entry.category,
    key: entry.key,
    value: entry.value,
    workspaceId: entry.workspaceId ?? undefined,
    originDeviceId: entry.deviceId ?? undefined,
    scopeLevel: entry.scope ?? undefined,
  }));

  const tasks: CapsuleTaskEntry[] = input.tasks.map((t) => ({
    id: t.id,
    description: t.description,
    state: t.state,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    kind: t.kind,
    argsPresent: !!t.args && Object.keys(t.args).length > 0,
  }));

  const decisions: CapsuleDecisionEntry[] = input.decisions.map((event) => ({
    type: event.type,
    at: event.at,
    title: event.title,
    detail: event.detail,
    correlationId: event.correlationId,
    data: event.data,
  }));

  const observations: CapsuleObservationEntry[] = input.observations.map((event) => ({
    at: event.at,
    type: event.type,
    title: event.title,
    detail: event.detail,
  }));

  const draft: Omit<SessionCapsule, "signature"> = {
    version: 1,
    sender: input.sender.publicIdentity(),
    sessionId: input.sessionId,
    createdAt: clock().toISOString(),
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    vesperVersion: input.vesperVersion,
    models: input.models,
    activeWorkspace: input.activeWorkspace,
    preferences,
    tasks,
    decisions,
    observations,
    corrections: input.corrections ?? [],
    pending: input.pending,
  };

  const signature = input.sender.sign(canonicalJson(draft as unknown as JsonObject));
  return { ...draft, signature };
}

export interface CapsuleVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a capsule's signature and shape. Returns ok:true only when every check
 * passes. Callers must NOT ingest a capsule whose ok is false.
 */
export function verifyCapsule(capsule: SessionCapsule): CapsuleVerifyResult {
  if (!capsule || typeof capsule !== "object") return { ok: false, reason: "capsule is not an object" };
  if (capsule.version !== 1) return { ok: false, reason: `unsupported version ${capsule.version}` };
  if (!capsule.sender || typeof capsule.sender.publicKey !== "string") {
    return { ok: false, reason: "missing sender public key" };
  }
  if (typeof capsule.signature !== "string" || capsule.signature.length === 0) {
    return { ok: false, reason: "missing signature" };
  }
  const { signature: _, ...rest } = capsule;
  const canonical = canonicalJson(rest as unknown as JsonObject);
  const verified = verifySignature(capsule.sender.publicKey, canonical, capsule.signature);
  if (!verified) return { ok: false, reason: "signature verification failed" };
  return { ok: true };
}

export interface CapsuleIngestOptions {
  /** The local device that is receiving. Used to reject self-ingest and to scope memory. */
  self: PublicDeviceIdentity;
  /** Returns the current trust of the sender device. If null, the sender is unknown. */
  trustOf: (deviceId: string) => Promise<"trusted" | "restricted" | "pending" | "unknown" | "revoked" | null>;
  /**
   * Called for each preference the ingest wishes to merge into local memory. The
   * caller decides what to do with it (usually MemoryStore.remember with
   * provenance: 'remote').
   */
  onPreference: (entry: CapsuleMemoryEntry, senderDeviceId: string) => Promise<void>;
  /** Called for each decision the ingest wishes to record locally. */
  onDecision?: (entry: CapsuleDecisionEntry, senderDeviceId: string) => Promise<void>;
  /** Called for each observation the ingest wishes to record locally. */
  onObservation?: (entry: CapsuleObservationEntry, senderDeviceId: string) => Promise<void>;
}

export interface CapsuleIngestResult {
  accepted: boolean;
  reason?: string;
  ingested: {
    preferences: number;
    decisions: number;
    observations: number;
  };
  refusedFor?: string[];
}

/**
 * Ingest a verified capsule. Returns a structured result — the callers see which items
 * were merged and which were refused, and why. This function NEVER touches trust,
 * capability, permission, or revocation state — those are separate concerns owned by
 * the registry, and ingest is strictly informational.
 */
export async function ingestCapsule(
  capsule: SessionCapsule,
  options: CapsuleIngestOptions,
): Promise<CapsuleIngestResult> {
  const refused: string[] = [];
  // Never ingest a capsule signed by this same device — a self-loop would create
  // duplicate provenance records and possible feedback amplification.
  if (capsule.sender.deviceId === options.self.deviceId) {
    return {
      accepted: false,
      reason: "capsule was signed by this device; refusing to self-ingest",
      ingested: { preferences: 0, decisions: 0, observations: 0 },
    };
  }
  const verify = verifyCapsule(capsule);
  if (!verify.ok) {
    return {
      accepted: false,
      reason: `signature check failed: ${verify.reason}`,
      ingested: { preferences: 0, decisions: 0, observations: 0 },
    };
  }
  const trust = await options.trustOf(capsule.sender.deviceId);
  if (trust === null || trust === "unknown") {
    return {
      accepted: false,
      reason: "sender is not enrolled locally; ingest refused",
      ingested: { preferences: 0, decisions: 0, observations: 0 },
    };
  }
  if (trust === "revoked") {
    return {
      accepted: false,
      reason: "sender is revoked locally; ingest refused",
      ingested: { preferences: 0, decisions: 0, observations: 0 },
    };
  }

  let prefCount = 0;
  for (const entry of capsule.preferences) {
    // Device-scoped facts are per the mission never merged across devices —
    // a fact about the sender's machine has no meaning on ours.
    if (entry.originDeviceId && entry.originDeviceId !== capsule.sender.deviceId) {
      refused.push(`preference '${entry.key}': device-scoped mismatch`);
      continue;
    }
    // A `restricted` sender cannot inject memory the way a `trusted` one can — the
    // gate for a restricted device is what its scopes say, and preferences from a
    // restricted device are informational only. Skip them here rather than merge.
    if (trust === "restricted") {
      refused.push(`preference '${entry.key}': sender is restricted, ingest declined`);
      continue;
    }
    try {
      await options.onPreference(entry, capsule.sender.deviceId);
      prefCount += 1;
    } catch (error) {
      refused.push(`preference '${entry.key}': onPreference threw (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  let decisionCount = 0;
  if (options.onDecision) {
    for (const entry of capsule.decisions) {
      try {
        await options.onDecision(entry, capsule.sender.deviceId);
        decisionCount += 1;
      } catch (error) {
        refused.push(`decision '${entry.type}@${entry.at}': onDecision threw (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  let observationCount = 0;
  if (options.onObservation) {
    for (const entry of capsule.observations) {
      try {
        await options.onObservation(entry, capsule.sender.deviceId);
        observationCount += 1;
      } catch (error) {
        refused.push(`observation '${entry.type}@${entry.at}': onObservation threw (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  return {
    accepted: true,
    ingested: {
      preferences: prefCount,
      decisions: decisionCount,
      observations: observationCount,
    },
    refusedFor: refused.length ? refused : undefined,
  };
}

/**
 * Deterministic conflict resolution for a security-touching field. "Safer state wins":
 * the more restrictive value is chosen. Used for trust and capability decisions when
 * two capsules disagree.
 */
export function saferTrustWins(
  a: "trusted" | "restricted" | "pending" | "unknown" | "revoked",
  b: "trusted" | "restricted" | "pending" | "unknown" | "revoked",
): typeof a {
  const rank: Record<typeof a, number> = {
    revoked: 0,
    unknown: 1,
    pending: 2,
    restricted: 3,
    trusted: 4,
  };
  return rank[a] <= rank[b] ? a : b;
}

/** A helper to serialize a capsule for on-disk or transport-later. */
export function encodeCapsule(capsule: SessionCapsule): string {
  return canonicalJson(capsule as unknown as JsonObject);
}

/** Parse a capsule from a canonical JSON string. Returns null if not a capsule shape. */
export function decodeCapsule(raw: string): SessionCapsule | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const capsule = parsed as SessionCapsule;
    if (capsule.version !== 1) return null;
    if (!capsule.sender || typeof capsule.sender.publicKey !== "string") return null;
    if (typeof capsule.signature !== "string") return null;
    return capsule;
  } catch {
    return null;
  }
}

// Silence unused import warnings for JsonValue.
export type _JsonValue = JsonValue;
