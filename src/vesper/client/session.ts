import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createId } from "../id.ts";
import {
  CLIENT_SCOPES,
  DEFAULT_COMPANION_SCOPES,
  clientError,
  type ClientError,
  type ClientScope,
} from "./protocol.ts";

export interface ClientSession {
  id: string;
  token: string;
  deviceLabel: string;
  scopes: ClientScope[];
  issuedAt: string;
  expiresAt: string;
}

export interface IssueSessionInput {
  deviceLabel: string;
  scopes?: ClientScope[];
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class ClientSessionStore {
  private readonly sessions = new Map<string, ClientSession>();

  issue(input: IssueSessionInput): ClientSession {
    const scopes = normalizeScopes(input.scopes ?? DEFAULT_COMPANION_SCOPES);
    const now = Date.now();
    const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 30_000), 60 * 60 * 1000);
    const session: ClientSession = {
      id: createId("session"),
      token: randomBytes(24).toString("base64url"),
      deviceLabel: input.deviceLabel.trim() || "unnamed-device",
      scopes,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  authenticate(token: string | undefined, at = Date.now()): ClientSession | ClientError {
    if (!token) return clientError("UNAUTHENTICATED", "No client session token.");
    const session = [...this.sessions.values()].find((item) => safeEqual(item.token, token));
    if (!session) return clientError("UNAUTHENTICATED", "Unknown client session.");
    if (Date.parse(session.expiresAt) <= at) {
      this.sessions.delete(session.id);
      return clientError("EXPIRED", "Client session expired.");
    }
    return session;
  }

  require(token: string | undefined, scope: ClientScope, at = Date.now()): ClientSession | ClientError {
    const session = this.authenticate(token, at);
    if ("ok" in session) return session;
    if (!session.scopes.includes(scope)) {
      return clientError("SCOPE_DENIED", `Session lacks scope '${scope}'.`);
    }
    return session;
  }

  revoke(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): Omit<ClientSession, "token">[] {
    return [...this.sessions.values()].map(({ token: _token, ...rest }) => rest);
  }
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
