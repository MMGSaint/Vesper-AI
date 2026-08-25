/**
 * Versioned client contract for future Windows/Android companions.
 *
 * This is not a network server. Transport is a later, authenticated layer.
 * The contract exists so clients cannot invent authority: a connected
 * phone is still subject to Vesper permissions, scopes, and expiry.
 */

export const CLIENT_PROTOCOL_ID = "vesper.client";
export const CLIENT_PROTOCOL_VERSION = 1 as const;

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
