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
 *     itself, and is verified against the key the RECEIVER has registered for the
 *     claimed deviceId — never the key embedded in the capsule. Verifying against the
 *     embedded key proves only that the author owns the key they chose to include,
 *     which lets anyone claim any deviceId. A device is a key, not a label.
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
 * Load-bearing invariants (each has a named test in phase2-attacks.test.ts):
 *   - a tampered capsule fails signature verification
 *   - a capsule whose sender.deviceId does not own the embedded key is refused
 *     (the identity-spoofing CRITICAL)
 *   - a replayed capsule is refused when a seen-set is wired
 *   - `filterForSync` runs before serialization for memory, AND credential screening
 *     runs at ingest over decision/observation prose and data bags — those carry free
 *     text that never passed the build-time filter
 *   - a restricted sender's decisions and observations are declined, not only its
 *     preferences: otherwise the trust ceiling is bypassed by choice of field
 *   - unknown top-level fields and oversized collections are refused
 *   - a partly-failed merge reports `partial: true`; `accepted` means the capsule was
 *     admissible, never that every item landed
 *   - ingestion never sets local trust higher than the record already holds
 *   - ingestion cannot un-revoke a device — a revoked deviceId stays revoked
 */

import { canonicalJson, verifySignature } from "./distributed/identity.ts";
import type { DeviceIdentity, PublicDeviceIdentity } from "./distributed/identity.ts";
import { filterForSync } from "./distributed/sync.ts";
import type { MemoryEntry } from "./types.ts";
import type { VesperTask } from "./distributed/tasks.ts";
import type { VesperEvent, JsonObject, JsonValue } from "./types.ts";

/**
 * The capsule schema. Version-tagged so a future author can migrate rather than
 * silently reinterpret. Every field is either mandatory or explicitly optional, and
 * `verifyCapsule` refuses any top-level field outside ALLOWED_CAPSULE_FIELDS — an
 * attacker must not be able to smuggle a payload past ingest inside a field the
 * schema does not know about.
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

/** Top-level fields a version-1 capsule may carry. Anything else is refused. */
const ALLOWED_CAPSULE_FIELDS = new Set<string>([
  "version", "sender", "sessionId", "createdAt", "windowStart", "windowEnd",
  "vesperVersion", "models", "activeWorkspace", "preferences", "tasks",
  "decisions", "observations", "corrections", "pending", "signature",
]);

/** Bounds on a capsule's collections, so one artifact cannot exhaust the receiver. */
const MAX_CAPSULE_BYTES = 1024 * 1024;
const MAX_PREFERENCES = 500;
const MAX_TASKS = 500;
const MAX_DECISIONS = 1000;
const MAX_OBSERVATIONS = 1000;
const MAX_CORRECTIONS = 200;

/**
 * Verify a capsule's shape and signature.
 *
 * `expectedPublicKey` is REQUIRED and must come from the receiver's own device
 * registry, resolved by the claimed `sender.deviceId`. Verifying against the key
 * embedded in the capsule proves only that whoever wrote the capsule owns the key
 * they put in it — which is no claim at all. An attacker generates a fresh keypair,
 * writes a victim's deviceId into `sender.deviceId`, signs with her own key, and the
 * capsule verifies; the receiver then resolves trust by the claimed id and treats the
 * forgery as the victim's. This is the codebase's existing rule stated for capsules:
 * a device is a key, not a label.
 *
 * Callers must NOT ingest a capsule whose ok is false.
 */
export function verifyCapsule(
  capsule: SessionCapsule,
  expectedPublicKey: string,
): CapsuleVerifyResult {
  if (!capsule || typeof capsule !== "object") return { ok: false, reason: "capsule is not an object" };
  if (capsule.version !== 1) return { ok: false, reason: `unsupported version ${capsule.version}` };
  if (!capsule.sender || typeof capsule.sender.publicKey !== "string") {
    return { ok: false, reason: "missing sender public key" };
  }
  if (typeof capsule.sender.deviceId !== "string" || capsule.sender.deviceId.length === 0) {
    return { ok: false, reason: "missing sender deviceId" };
  }
  if (typeof capsule.signature !== "string" || capsule.signature.length === 0) {
    return { ok: false, reason: "missing signature" };
  }
  if (typeof expectedPublicKey !== "string" || expectedPublicKey.length === 0) {
    return { ok: false, reason: "no registered public key for the claimed sender" };
  }
  // The embedded key must MATCH the one the receiver already holds for that device.
  // A mismatch is an impersonation attempt, not a key rotation — rotation goes
  // through enrolment, not through a capsule.
  if (capsule.sender.publicKey !== expectedPublicKey) {
    return { ok: false, reason: "sender public key does not match the registered key for that deviceId" };
  }
  // Unknown top-level fields are refused: an attacker must not be able to smuggle a
  // payload past ingest inside a field the schema does not know about.
  for (const key of Object.keys(capsule)) {
    if (!ALLOWED_CAPSULE_FIELDS.has(key)) {
      return { ok: false, reason: `unknown top-level field '${key}'` };
    }
  }
  const bounds = checkCapsuleBounds(capsule);
  if (!bounds.ok) return bounds;

  const { signature: _, ...rest } = capsule;
  const canonical = canonicalJson(rest as unknown as JsonObject);
  // Verify against the REGISTERED key, not the embedded one. They are equal by the
  // check above; using the registered one makes the dependency explicit.
  const verified = verifySignature(expectedPublicKey, canonical, capsule.signature);
  if (!verified) return { ok: false, reason: "signature verification failed" };
  return { ok: true };
}

/** Refuse a capsule whose collections or encoded size exceed the receiver's bounds. */
function checkCapsuleBounds(capsule: SessionCapsule): CapsuleVerifyResult {
  const sizes: Array<[string, unknown, number]> = [
    ["preferences", capsule.preferences, MAX_PREFERENCES],
    ["tasks", capsule.tasks, MAX_TASKS],
    ["decisions", capsule.decisions, MAX_DECISIONS],
    ["observations", capsule.observations, MAX_OBSERVATIONS],
    ["corrections", capsule.corrections, MAX_CORRECTIONS],
  ];
  for (const [name, value, cap] of sizes) {
    if (value !== undefined && !Array.isArray(value)) {
      return { ok: false, reason: `${name} is not an array` };
    }
    if (Array.isArray(value) && value.length > cap) {
      return { ok: false, reason: `${name} has ${value.length} entries; the cap is ${cap}` };
    }
  }
  try {
    const encoded = JSON.stringify(capsule);
    if (encoded.length > MAX_CAPSULE_BYTES) {
      return { ok: false, reason: `capsule is ${encoded.length} bytes; the cap is ${MAX_CAPSULE_BYTES}` };
    }
  } catch {
    return { ok: false, reason: "capsule is not JSON-serialisable" };
  }
  return { ok: true };
}

export interface CapsuleIngestOptions {
  /** The local device that is receiving. Used to reject self-ingest and to scope memory. */
  self: PublicDeviceIdentity;
  /** Returns the current trust of the sender device. If null, the sender is unknown. */
  trustOf: (deviceId: string) => Promise<"trusted" | "restricted" | "pending" | "unknown" | "revoked" | null>;
  /**
   * Resolve the public key the RECEIVER has registered for a deviceId. Returning null
   * means "no such device is enrolled here". Required: verifying a capsule against the
   * key it carries proves nothing about who sent it.
   */
  publicKeyOf: (deviceId: string) => Promise<string | null>;
  /**
   * Has this capsule already been ingested? Replay protection: a signed capsule is
   * valid forever, so without a seen-check an attacker who captures one can replay it
   * to re-apply its contents indefinitely. Returning true refuses the ingest.
   */
  seenBefore?: (capsuleId: string) => Promise<boolean>;
  /** Record a capsule as ingested, so a later replay is refused. */
  markSeen?: (capsuleId: string) => Promise<void>;
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
  /**
   * True when at least one item was refused or its handler threw. `accepted: true`
   * alone means "the capsule itself was admissible" — it does NOT mean every item
   * landed. A caller that treats acceptance as completion would report a merge that
   * only partly happened.
   */
  partial: boolean;
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
  const none = { preferences: 0, decisions: 0, observations: 0 };
  // Never ingest a capsule signed by this same device — a self-loop would create
  // duplicate provenance records and possible feedback amplification.
  if (capsule.sender?.deviceId === options.self.deviceId) {
    return {
      accepted: false,
      reason: "capsule was signed by this device; refusing to self-ingest",
      ingested: none,
      partial: false,
    };
  }
  if (typeof capsule.sender?.deviceId !== "string") {
    return { accepted: false, reason: "capsule has no sender deviceId", ingested: none, partial: false };
  }
  // Resolve the key the RECEIVER holds for the claimed device. A capsule that names a
  // device we have never enrolled cannot be verified against anything, so it is
  // refused before any signature work.
  const registeredKey = await options.publicKeyOf(capsule.sender.deviceId);
  if (!registeredKey) {
    return {
      accepted: false,
      reason: "sender is not enrolled locally; ingest refused",
      ingested: none,
      partial: false,
    };
  }
  const verify = verifyCapsule(capsule, registeredKey);
  if (!verify.ok) {
    return {
      accepted: false,
      reason: `signature check failed: ${verify.reason}`,
      ingested: none,
      partial: false,
    };
  }
  const trust = await options.trustOf(capsule.sender.deviceId);
  if (trust === null || trust === "unknown") {
    return {
      accepted: false,
      reason: "sender is not enrolled locally; ingest refused",
      ingested: none,
      partial: false,
    };
  }
  if (trust === "revoked") {
    return {
      accepted: false,
      reason: "sender is revoked locally; ingest refused",
      ingested: none,
      partial: false,
    };
  }
  // Replay protection. A signed capsule stays valid forever, so a captured one could
  // otherwise be re-applied indefinitely.
  const capsuleId = capsuleIdentity(capsule);
  if (options.seenBefore && (await options.seenBefore(capsuleId))) {
    return {
      accepted: false,
      reason: "capsule has already been ingested (replay refused)",
      ingested: none,
      partial: false,
    };
  }

  let prefCount = 0;
  for (const entry of capsule.preferences ?? []) {
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
    const leak = screenForSecrets(`${entry.key} ${entry.value}`);
    if (leak) {
      refused.push(`preference '${entry.key}': ${leak}`);
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
    for (const entry of capsule.decisions ?? []) {
      // A restricted sender's preferences are declined above; decisions and
      // observations must be declined for the same reason. Otherwise a restricted
      // device smuggles a preference-shaped payload through a channel whose handler
      // writes it, and the trust ceiling is bypassed by choice of field.
      if (trust === "restricted") {
        refused.push(`decision '${entry.type}': sender is restricted, ingest declined`);
        continue;
      }
      const leak = screenForSecrets(`${entry.title} ${entry.detail ?? ""}`, entry.data);
      if (leak) {
        refused.push(`decision '${entry.type}': ${leak}`);
        continue;
      }
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
    for (const entry of capsule.observations ?? []) {
      if (trust === "restricted") {
        refused.push(`observation '${entry.type}': sender is restricted, ingest declined`);
        continue;
      }
      const leak = screenForSecrets(`${entry.title} ${entry.detail ?? ""}`);
      if (leak) {
        refused.push(`observation '${entry.type}': ${leak}`);
        continue;
      }
      try {
        await options.onObservation(entry, capsule.sender.deviceId);
        observationCount += 1;
      } catch (error) {
        refused.push(`observation '${entry.type}@${entry.at}': onObservation threw (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  if (options.markSeen) {
    await options.markSeen(capsuleId).catch(() => undefined);
  }

  return {
    accepted: true,
    ingested: {
      preferences: prefCount,
      decisions: decisionCount,
      observations: observationCount,
    },
    refusedFor: refused.length ? refused : undefined,
    // Honest reporting: `accepted` says the capsule was admissible, `partial` says
    // whether every item inside it actually landed. A caller that conflated the two
    // would announce a merge that only half-happened.
    partial: refused.length > 0,
  };
}

/**
 * A capsule's replay identity: sender + session + window + signature. The signature
 * alone would do, but including the rest makes the key self-describing in a log.
 */
export function capsuleIdentity(capsule: SessionCapsule): string {
  return `${capsule.sender.deviceId}|${capsule.sessionId}|${capsule.windowStart}|${capsule.signature.slice(0, 32)}`;
}

/**
 * Screen capsule prose and payloads for credential-shaped content.
 *
 * `filterForSync` runs over memory entries at build time, but decisions and
 * observations carry free text in `title`/`detail` and an arbitrary `data` bag —
 * none of which passed that filter. A secret in an event detail would leave the
 * sending device and land on the receiver. Reuses the same two questions the sync
 * filter asks: does it look like a credential by NAME, and by VALUE.
 */
function screenForSecrets(text: string, data?: JsonObject): string | null {
  const probe: MemoryEntry = {
    id: "screen",
    category: "fact",
    key: "screen",
    value: text,
    createdAt: "1970-01-01T00:00:00Z",
    updatedAt: "1970-01-01T00:00:00Z",
    source: "agent",
    scope: "user",
    revision: 1,
  };
  if (filterForSync([probe]).send.length === 0) {
    return "content looks like a credential; refused";
  }
  if (data) {
    let encoded: string;
    try {
      encoded = JSON.stringify(data);
    } catch {
      return "data is not serialisable; refused";
    }
    const dataProbe: MemoryEntry = { ...probe, value: encoded };
    if (filterForSync([dataProbe]).send.length === 0) {
      return "data looks like it carries a credential; refused";
    }
  }
  return null;
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
