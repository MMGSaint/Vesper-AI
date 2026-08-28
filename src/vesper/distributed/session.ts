/**
 * Session grants: short-lived, scoped authority for a device.
 *
 * A portable Vesper on a stranger's computer must never carry a permanent credential.
 * If the stick is lost, whatever it held has to expire on its own and be revocable
 * without tearing down the rest of the ecosystem. So authority is a *grant*: issued by
 * a trusted device, scoped, time-boxed, and checked against live trust on every use.
 *
 * Three independent things are verified at use time, and all three must hold:
 *
 *   1. the grant is authentic       - signed by the issuer's key
 *   2. the grant is still valid     - not expired, not replayed
 *   3. the holder is still trusted  - checked live, so revocation takes effect at once
 *
 * Point 3 is why a grant is not a bearer token in the usual sense: possession alone
 * never suffices, because trust is re-read rather than baked in at issue time.
 */

import { randomUUID } from "node:crypto";
import type { ClientScope } from "../client/protocol.ts";
import { CLIENT_SCOPES, capScopesForTrust } from "../client/protocol.ts";
import type { TrustState } from "./identity.ts";
import { canonicalJson, safeEqual, verifySignature, type DeviceIdentity } from "./identity.ts";
import type { DeviceRegistry } from "./registry.ts";


export const SESSION_GRANT_VERSION = 1 as const;

/** Portable sessions are deliberately short. Long enough to work, short enough to lose. */
export const DEFAULT_GRANT_TTL_MS = 30 * 60_000;
export const MAX_GRANT_TTL_MS = 12 * 60 * 60_000;

export interface SessionGrant {
  v: typeof SESSION_GRANT_VERSION;
  sessionId: string;
  /** The device this grant authorises. */
  deviceId: string;
  /** The trusted device that issued it. */
  issuedBy: string;
  scopes: ClientScope[];
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface SignedGrant {
  grant: SessionGrant;
  signature: string;
}

export interface IssueInput {
  issuer: DeviceIdentity;
  deviceId: string;
  scopes: ClientScope[];
  ttlMs?: number;
  now?: () => number;
}

export function issueSessionGrant(input: IssueInput): SignedGrant {
  const now = (input.now ?? Date.now)();
  // A caller asking for a longer life than policy allows gets policy, not an error:
  // the safe outcome is a shorter session, never a longer one.
  const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_GRANT_TTL_MS, 1_000), MAX_GRANT_TTL_MS);
  const scopes = input.scopes.filter((scope) => CLIENT_SCOPES.includes(scope));
  const grant: SessionGrant = {
    v: SESSION_GRANT_VERSION,
    sessionId: `ses_${randomUUID()}`,
    deviceId: input.deviceId,
    issuedBy: input.issuer.deviceId,
    scopes,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    nonce: randomUUID(),
  };
  return { grant, signature: input.issuer.sign(canonicalJson(grant as unknown as never)) };
}

export type GrantFailure =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "REPLAYED"
  | "UNKNOWN_ISSUER"
  | "ISSUER_UNTRUSTED"
  | "UNKNOWN_DEVICE"
  | "DEVICE_UNTRUSTED"
  | "SCOPE_DENIED";

export interface GrantVerdict {
  ok: boolean;
  reason: GrantFailure | "OK";
  detail: string;
  grant?: SessionGrant;
}

/**
 * Bounded replay guard.
 *
 * Nonces are only useful until the grant they belong to expires, so entries are dropped
 * on expiry rather than kept forever. Unbounded, this would be a memory leak that an
 * attacker could drive.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly max: number;

  constructor(max = 4096) {
    // A floor keeps a mis-configured guard from degenerating to useless, but it stays
    // low enough that a caller's requested bound is honoured rather than overridden.
    this.max = Math.max(8, Math.floor(max));
  }

  /** True when this nonce is fresh; false when it has been used before. */
  admit(nonce: string, expiresAtMs: number, nowMs: number): boolean {
    for (const [key, expiry] of this.seen) {
      if (expiry <= nowMs) this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) {
      // Refuse rather than forget. The expired entries were already dropped above, so
      // everything still here belongs to a grant that has not expired — and grants live
      // up to twelve hours. Evicting one to make room did not merely lose a record, it
      // re-opened replay of a nonce that had genuinely been spent, and an attacker could
      // cause exactly that by flooding the guard with grants of their own.
      //
      // Failing closed here costs availability under pressure, which is the right way
      // round for a control whose entire purpose is to remember what was already used.
      return false;
    }
    this.seen.set(nonce, expiresAtMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface VerifyInput {
  signed: SignedGrant;
  registry: DeviceRegistry;
  replay: ReplayGuard;
  /** Scope the caller is trying to exercise, when checking a specific action. */
  requiredScope?: ClientScope;
  now?: () => number;
}

function fail(reason: GrantFailure, detail: string): GrantVerdict {
  return { ok: false, reason, detail };
}

export async function verifySessionGrant(input: VerifyInput): Promise<GrantVerdict> {
  const nowMs = (input.now ?? Date.now)();
  const signed = input.signed;
  const grant = signed?.grant;

  if (
    !grant ||
    grant.v !== SESSION_GRANT_VERSION ||
    typeof grant.deviceId !== "string" ||
    typeof grant.issuedBy !== "string" ||
    typeof grant.expiresAt !== "string" ||
    typeof grant.nonce !== "string" ||
    !Array.isArray(grant.scopes) ||
    typeof signed.signature !== "string"
  ) {
    return fail("MALFORMED", "The grant is not a well-formed session grant.");
  }

  const issuer = await input.registry.get(grant.issuedBy);
  if (!issuer) return fail("UNKNOWN_ISSUER", `Issuer ${grant.issuedBy} is not enrolled.`);
  // Only a trusted device may hand out authority. A restricted device cannot mint
  // grants, or a portable session could bootstrap itself into more power than it has.
  if (issuer.trust !== "trusted") {
    return fail("ISSUER_UNTRUSTED", `Issuer ${grant.issuedBy} is '${issuer.trust}', not trusted.`);
  }

  if (!verifySignature(issuer.identity.publicKey, canonicalJson(grant as unknown as never), signed.signature)) {
    return fail("BAD_SIGNATURE", "The grant signature does not verify against the issuer's key.");
  }

  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return fail("EXPIRED", "The grant has expired.");
  }

  const holder = await input.registry.get(grant.deviceId);
  if (!holder) return fail("UNKNOWN_DEVICE", `Device ${grant.deviceId} is not enrolled.`);
  // Live trust, not trust at issue time: this is what makes revocation immediate.
  if (holder.trust !== "trusted" && holder.trust !== "restricted") {
    return fail("DEVICE_UNTRUSTED", `Device ${grant.deviceId} is '${holder.trust}'.`);
  }

  // Cap by live trust, exactly as the client session store does.
  //
  // Two authorization models owned the same question and only one applied the ceiling:
  // a grant minted while a device was trusted kept every scope it was signed with, so a
  // device demoted to `restricted` — the portable class, on a host nobody can vouch for
  // — went on holding memory.write and operator.confirm until the grant expired. Trust
  // is re-read here already; the scopes have to be re-read with it, or the demotion is
  // only half applied.
  const effectiveScopes = capScopesForTrust(grant.scopes, holder.trust);
  if (input.requiredScope && !effectiveScopes.includes(input.requiredScope)) {
    return fail(
      "SCOPE_DENIED",
      grant.scopes.includes(input.requiredScope)
        ? `A '${holder.trust}' device may not exercise the '${input.requiredScope}' scope.`
        : `The grant does not carry the '${input.requiredScope}' scope.`,
    );
  }

  if (!input.replay.admit(grant.nonce, expiresAtMs, nowMs)) {
    return fail("REPLAYED", "This grant nonce has already been used.");
  }

  return {
    ok: true,
    reason: "OK",
    detail: `Accepted session ${grant.sessionId} for ${holder.trust} device ${grant.deviceId}.`,
    grant: { ...grant, scopes: effectiveScopes },
  };
}

/** True when two grants refer to the same session, compared without timing leaks. */
export function sameSession(a: SessionGrant, b: SessionGrant): boolean {
  return safeEqual(a.sessionId, b.sessionId);
}
