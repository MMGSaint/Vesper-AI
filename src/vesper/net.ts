/**
 * Endpoint policy for a local-first assistant.
 *
 * Vesper talks to backends the user runs: an inference server on this machine or on the
 * box next to it, and (when it exists) a PC optimizer on localhost. A configured string
 * is attacker-influenced input the moment a config file, a synced settings blob, or a
 * tool-written value can reach it, so "http://..." on its own proves nothing about where
 * the request lands.
 *
 * The rule implemented here:
 *
 *   loopback   127.0.0.0/8, ::1, `localhost` / `*.localhost`   -> allowed
 *   private    10/8, 172.16/12, 192.168/16, fc00::/7 (ULA)     -> allowed (LAN backend)
 *   link-local 169.254.0.0/16, fe80::/10                       -> REFUSED, never opt-in
 *   metadata   169.254.169.254, fd00:ec2::254, metadata.google.internal
 *                                                              -> REFUSED, never opt-in
 *   public     everything else, including every hostname that
 *              is not `localhost`                              -> refused unless the
 *                                                                 caller opts in
 *
 * Two deliberate strictnesses:
 *
 *  - A bare hostname is treated as public even if it happens to resolve to 127.0.0.1
 *    today. Names are resolved by the OS at connect time, so `evil.example` (or a
 *    rebinding record with a one-second TTL) can point anywhere between validation and
 *    the request. Only literals and `localhost` (which RFC 6761 pins to loopback) are
 *    trusted.
 *  - Link-local and instance-metadata addresses are refused with no escape hatch. They
 *    are never a user's model server, and 169.254.169.254 is the canonical SSRF target
 *    for stealing cloud credentials. `fd00:ec2::254` is checked explicitly because it
 *    sits inside the otherwise-allowed ULA range.
 *
 * Credentials embedded in the URL are refused too: they would be replayed to whatever
 * host the endpoint names, and Vesper has no reason to carry them there.
 */

import { isIP } from "node:net";

export type EndpointScope = "loopback" | "private" | "link-local" | "metadata" | "public";

export interface EndpointCheck {
  ok: boolean;
  scope: EndpointScope | null;
  host: string | null;
  reason: string;
}

/** AWS IMDS over IPv6. Inside fc00::/7, so it needs an explicit check. */
const AWS_IMDS_V6 = Uint8Array.from([
  0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54,
]);

const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "metadata.goog"]);

function parseIpv4(raw: string): Uint8Array | null {
  if (isIP(raw) !== 4) return null;
  return Uint8Array.from(raw.split(".").map((part) => Number(part)));
}

/** Expand any valid IPv6 text form - including `::` and a trailing dotted quad - to 16 bytes. */
function parseIpv6(raw: string): Uint8Array | null {
  let addr = raw.split("%")[0] ?? "";
  if (isIP(addr) !== 6) return null;

  // `::ffff:127.0.0.1` and `::ffff:7f00:1` must classify identically.
  if (addr.includes(".")) {
    const cut = addr.lastIndexOf(":") + 1;
    const quad = parseIpv4(addr.slice(cut));
    if (!quad) return null;
    const hi = (((quad[0] ?? 0) << 8) | (quad[1] ?? 0)).toString(16);
    const lo = (((quad[2] ?? 0) << 8) | (quad[3] ?? 0)).toString(16);
    addr = `${addr.slice(0, cut)}${hi}:${lo}`;
  }

  const [head = "", tail] = addr.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  let groups: string[];
  if (tail === undefined) {
    if (headGroups.length !== 8) return null;
    groups = headGroups;
  } else {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...new Array<string>(missing).fill("0"), ...tailGroups];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const value = Number.parseInt(groups[i] || "0", 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function scopeOfIpv4(b: Uint8Array): EndpointScope {
  const [a = 0, second = 0, third = 0, fourth = 0] = b;
  if (a === 127) return "loopback";
  if (a === 169 && second === 254) {
    return third === 169 && fourth === 254 ? "metadata" : "link-local";
  }
  if (a === 10) return "private";
  if (a === 172 && second >= 16 && second <= 31) return "private";
  if (a === 192 && second === 168) return "private";
  return "public";
}

function scopeOfIpv6(b: Uint8Array): EndpointScope {
  if (b.every((byte, index) => byte === AWS_IMDS_V6[index])) return "metadata";
  // ::ffff:0:0/96 - an IPv4 address wearing an IPv6 costume.
  const mapped =
    b.slice(0, 10).every((byte) => byte === 0) && b[10] === 0xff && b[11] === 0xff;
  if (mapped) return scopeOfIpv4(b.slice(12));
  if (b.slice(0, 15).every((byte) => byte === 0) && b[15] === 1) return "loopback";
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return "private";
  if ((b[0] ?? 0) === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) return "link-local";
  return "public";
}

/**
 * Classify a URL's host. Returns null when the input is not a usable http(s) endpoint;
 * callers must treat that as a refusal rather than guessing.
 */
export function classifyEndpoint(
  raw: string,
): { scope: EndpointScope; host: string; protocol: "http:" | "https:" } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  // WHATWG parsing already folds 0x7f000001, 2130706433 and 127.1 to 127.0.0.1, so the
  // decimal/octal/hex spellings of an address cannot slip past the range checks below.
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const host = bracketed ? url.hostname.slice(1, -1) : url.hostname;
  if (!host) return null;

  const protocol = url.protocol as "http:" | "https:";
  const v4 = parseIpv4(host);
  if (v4) {
    // 0.0.0.0 is a bind address, not a destination.
    if (v4.every((byte) => byte === 0)) return null;
    return { scope: scopeOfIpv4(v4), host, protocol };
  }
  const v6 = parseIpv6(host);
  if (v6) {
    if (v6.every((byte) => byte === 0)) return null;
    return { scope: scopeOfIpv6(v6), host, protocol };
  }

  const name = host.replace(/\.$/, "").toLowerCase();
  if (METADATA_HOSTS.has(name)) return { scope: "metadata", host, protocol };
  if (name === "localhost" || name.endsWith(".localhost")) {
    return { scope: "loopback", host, protocol };
  }
  return { scope: "public", host, protocol };
}

/**
 * Decide whether `raw` may be used as a local backend endpoint.
 *
 * `allowRemote` is the user's explicit opt-in for a public host. It cannot unlock
 * link-local or metadata addresses - those stay refused whatever the config says.
 */
export function checkLocalEndpoint(
  raw: string,
  options: { allowRemote?: boolean; label?: string } = {},
): EndpointCheck {
  const label = options.label ?? "endpoint";
  const classified = classifyEndpoint(raw);
  if (!classified) {
    return {
      ok: false,
      scope: null,
      host: null,
      reason: `${label} must be an http(s) URL with a routable host and no embedded credentials`,
    };
  }
  const { scope, host } = classified;
  if (scope === "metadata" || scope === "link-local") {
    return {
      ok: false,
      scope,
      host,
      reason: `${label} points at a ${scope} address (${host}); this is refused and cannot be enabled`,
    };
  }
  if (scope === "public" && !options.allowRemote) {
    return {
      ok: false,
      scope,
      host,
      reason: `${label} must be loopback or a private address; ${host} is not local and remote endpoints are not enabled`,
    };
  }
  return { ok: true, scope, host, reason: `${label} resolves to a ${scope} host` };
}

/**
 * Decide whether `raw` may be used as an optional-cloud endpoint - one Vesper sends an
 * API key to.
 *
 * A remote host is the point here, so "public" is fine. What is refused is a target that
 * would either leak the key in cleartext or hand it to infrastructure the user does not
 * own: plain http to anywhere but this machine, and any link-local or metadata address.
 */
export function checkCloudEndpoint(raw: string, label = "endpoint"): EndpointCheck {
  const classified = classifyEndpoint(raw);
  if (!classified) {
    return {
      ok: false,
      scope: null,
      host: null,
      reason: `${label} must be an http(s) URL with a routable host and no embedded credentials`,
    };
  }
  const { scope, host, protocol } = classified;
  if (scope === "metadata" || scope === "link-local") {
    return {
      ok: false,
      scope,
      host,
      reason: `${label} points at a ${scope} address (${host}); this is refused and cannot be enabled`,
    };
  }
  if (protocol === "http:" && scope !== "loopback") {
    return {
      ok: false,
      scope,
      host,
      reason: `${label} carries an API key, so it must use https unless it is loopback; ${host} is not`,
    };
  }
  return { ok: true, scope, host, reason: `${label} is an acceptable ${scope} https target` };
}
