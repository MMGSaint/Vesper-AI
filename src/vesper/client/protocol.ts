/**
 * Versioned client contract for Windows/Android companions and portable sessions.
 *
 * This is not a network server. Transport is a later, authenticated layer.
 * The contract exists so clients cannot invent authority: a connected
 * phone is still subject to Vesper permissions, scopes, and expiry.
 *
 * Version 2 binds a session to a registered device identity. Version 1 authenticated a
 * free-text `deviceLabel`, which meant a label was the only thing a caller needed to
 * assert and revoking a device left its live sessions working until they expired. A
 * label is a name; a device id is a key the holder must actually possess, and trust in
 * it is a live property of the registry rather than a fact frozen at issue time.
 *
 * There is deliberately only one of these contracts. A phone on the sofa, a laptop in
 * another room, and Vesper running from a USB stick on someone else's PC are the same
 * kind of thing — a device with an identity, a trust state, and a capability manifest —
 * and they differ by trust class, not by protocol.
 */

export const CLIENT_PROTOCOL_ID = "vesper.client";
export const CLIENT_PROTOCOL_VERSION = 2 as const;

export const CAPABILITY_STATES = [
  "AVAILABLE",
  "UNAVAILABLE",
  "DEGRADED",
  "NOT_CONFIGURED",
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CLIENT_SCOPES = [
  "status",
  "conversation",
  "memory.read",
  "memory.write",
  "knowledge.read",
  "notifications",
  "operator.confirm",
] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

export const DEFAULT_COMPANION_SCOPES: ClientScope[] = [
  "status",
  "conversation",
  "memory.read",
  "notifications",
];

/**
 * The ceiling for a RESTRICTED device: a portable session, or a companion the user has
 * admitted but not promoted. Read and converse, never write and never confirm — a
 * device in this class is one whose surroundings Vesper cannot vouch for, so it may ask
 * questions and see answers but may not change the user's record or approve an action
 * on their behalf.
 */
export const RESTRICTED_COMPANION_SCOPES: ClientScope[] = [
  "status",
  "conversation",
  "knowledge.read",
];

/**
 * The scopes a device of this trust class may actually exercise.
 *
 * The single owner of that rule. It was written out three times — the client session
 * store, the signed-grant verifier, and the agent's own re-check — and a ceiling copied
 * three times is a ceiling that will eventually differ in one of them.
 */
export function capScopesForTrust(
  scopes: readonly ClientScope[],
  trust: "unknown" | "pending" | "restricted" | "trusted" | "revoked",
): ClientScope[] {
  if (trust === "trusted") return [...scopes];
  if (trust !== "restricted") return [];
  const ceiling = new Set<ClientScope>(RESTRICTED_COMPANION_SCOPES);
  return scopes.filter((scope) => ceiling.has(scope));
}

/** Scopes a remote companion must never receive. OS tools stay on the host. */
export const FORBIDDEN_REMOTE_POWERS = [
  "os.filesystem",
  "os.subprocess",
  "os.shell",
  "optimizer.mutate",
  "permissions.relax",
  "security.disable",
] as const;

export interface CapabilityReport {
  id: string;
  state: CapabilityState;
  detail: string;
}

export interface ClientHello {
  protocol: typeof CLIENT_PROTOCOL_ID;
  version: typeof CLIENT_PROTOCOL_VERSION;
  core: string;
  instanceId: string;
  /** The device serving this session, so a client can tell two Vespers apart. */
  deviceId: string;
  /** Whether this Vesper is running on hardware its user controls. */
  hostPosture: "owned" | "foreign";
  started: boolean;
}

export interface ClientError {
  ok: false;
  code:
    | "UNAUTHENTICATED"
    | "EXPIRED"
    | "SCOPE_DENIED"
    | "PERMISSION_DENIED"
    | "CONFIRM_REQUIRED"
    | "NOT_FOUND"
    | "UNAVAILABLE"
    | "INVALID";
  detail: string;
}

export function clientError(
  code: ClientError["code"],
  detail: string,
): ClientError {
  return { ok: false, code, detail };
}

export function isClientError(value: unknown): value is ClientError {
  return Boolean(value && typeof value === "object" && (value as ClientError).ok === false);
}
