import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createId } from "../id.ts";
import {
  CLIENT_SCOPES,
  DEFAULT_COMPANION_SCOPES,
  RESTRICTED_COMPANION_SCOPES,
  clientError,
  type ClientError,
  type ClientScope,
} from "./protocol.ts";
import type { TrustState } from "../distributed/identity.ts";

/**
 * Asks the device registry what a device's trust state is *right now*.
 *
 * This is a callback rather than a registry reference so the session store stays
 * testable without a filesystem, but the shape is the point: it is consulted on every
 * request, never cached into the session. Trust is a live property. A token is evidence
 * that a device authenticated once; only the registry knows whether it still may.
 */
export type DeviceTrustLookup = (deviceId: string) => Promise<TrustState>;

export interface ClientSession {
  id: string;
  token: string;
  /** The registered device this session belongs to. Not a label the caller chose. */
  deviceId: string;
  deviceLabel: string;
  scopes: ClientScope[];
  issuedAt: string;
  expiresAt: string;
}

export interface IssueSessionInput {
  deviceId: string;
  deviceLabel?: string;
  scopes?: ClientScope[];
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class ClientSessionStore {
  private readonly sessions = new Map<string, ClientSession>();
  private readonly trustOf: DeviceTrustLookup;

  constructor(trustOf: DeviceTrustLookup) {
    this.trustOf = trustOf;
  }

  /**
   * Issue a session to an enrolled device.
   *
   * Enrolment is not approval: a `pending` device is one Vesper has seen but the user
   * has not admitted, and it gets nothing. A `restricted` device gets a session, but
   * capped — see `RESTRICTED_COMPANION_SCOPES`.
   */
  async issue(input: IssueSessionInput): Promise<ClientSession | ClientError> {
    const trust = await this.trustOf(input.deviceId);
    if (trust !== "trusted" && trust !== "restricted") {
      return clientError(
        "UNAUTHENTICATED",
        `Device ${input.deviceId} is ${trust}; only an enrolled and approved device can open a session.`,
      );
    }
    const requested = normalizeScopes(input.scopes ?? DEFAULT_COMPANION_SCOPES);
    const scopes = capScopes(requested, trust);
    const now = Date.now();
    const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 30_000), 60 * 60 * 1000);
    const session: ClientSession = {
      id: createId("session"),
      token: randomBytes(24).toString("base64url"),
      deviceId: input.deviceId,
      deviceLabel: input.deviceLabel?.trim() || "unnamed-device",
      scopes,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Three independent checks, in order of cost: the token, the clock, and the registry.
   *
   * The registry check is last but it is not optional — it is what makes revocation
   * take effect at the moment the user revokes rather than whenever the token happens
   * to expire. A device downgraded to `restricted` mid-session also has its scopes
   * re-capped here, so a demotion bites immediately too.
   */
  async authenticate(
    token: string | undefined,
    at = Date.now(),
  ): Promise<ClientSession | ClientError> {
    if (!token) return clientError("UNAUTHENTICATED", "No client session token.");
    const session = [...this.sessions.values()].find((item) => safeEqual(item.token, token));
    if (!session) return clientError("UNAUTHENTICATED", "Unknown client session.");
    if (Date.parse(session.expiresAt) <= at) {
      this.sessions.delete(session.id);
      return clientError("EXPIRED", "Client session expired.");
    }
    const trust = await this.trustOf(session.deviceId);
    if (trust !== "trusted" && trust !== "restricted") {
      // The device lost its standing. The token is now worthless, so stop honouring it.
      this.sessions.delete(session.id);
      return clientError(
        "UNAUTHENTICATED",
        `Device ${session.deviceId} is ${trust}; its sessions are no longer valid.`,
      );
    }
    return { ...session, scopes: capScopes(session.scopes, trust) };
  }

  async require(
    token: string | undefined,
    scope: ClientScope,
    at = Date.now(),
  ): Promise<ClientSession | ClientError> {
    const session = await this.authenticate(token, at);
    if ("ok" in session) return session;
    if (!session.scopes.includes(scope)) {
      return clientError("SCOPE_DENIED", `Session lacks scope '${scope}'.`);
    }
    return session;
  }

  /** Drop every session belonging to a device, without waiting for the next request. */
  revokeDevice(deviceId: string): number {
    let dropped = 0;
    for (const [id, session] of this.sessions) {
      if (session.deviceId === deviceId && this.sessions.delete(id)) dropped += 1;
    }
    return dropped;
  }

  revoke(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): Omit<ClientSession, "token">[] {
    return [...this.sessions.values()].map(({ token: _token, ...rest }) => rest);
  }
}

/**
 * A restricted device cannot hold more than the restricted ceiling, whatever it asked
 * for and whatever it held a moment ago. Applied at issue *and* on every request, so a
 * demotion cannot be outlived by a session opened while the device was still trusted.
 */
function capScopes(scopes: ClientScope[], trust: TrustState): ClientScope[] {
  if (trust !== "restricted") return scopes;
  const ceiling = new Set<ClientScope>(RESTRICTED_COMPANION_SCOPES);
  return scopes.filter((scope) => ceiling.has(scope));
}

function normalizeScopes(scopes: ClientScope[]): ClientScope[] {
  const allowed = new Set<ClientScope>(CLIENT_SCOPES);
  const unique = [...new Set(scopes.filter((scope) => allowed.has(scope)))];
  if (!unique.includes("status")) unique.unshift("status");
  return unique;
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
