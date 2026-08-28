/**
 * The distributed session-grant layer (src/vesper/distributed/session.ts).
 * Two hypotheses:
 *  H1  A grant can carry scopes above the holder's trust ceiling
 *      (RESTRICTED_COMPANION_SCOPES is enforced in client/session.ts but nowhere here).
 *  H2  The ReplayGuard's "drop the oldest rather than refuse service" eviction
 *      re-opens replay for an already-spent nonce.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceIdentity } from "../../../../src/vesper/distributed/identity.ts";
import { DeviceRegistry } from "../../../../src/vesper/distributed/registry.ts";
import { issueSessionGrant, verifySessionGrant, ReplayGuard } from "../../../../src/vesper/distributed/session.ts";
import { RESTRICTED_COMPANION_SCOPES } from "../../../../src/vesper/client/protocol.ts";
import { MemoryStorage } from "../../../../src/vesper/storage.ts";

async function ident(name: string) {
  const dirs = { data: await mkdtemp(join(tmpdir(), `vg-${name}-`)) };
  return (await loadDeviceIdentity({ dirs, name, deviceType: "laptop", vesperVersion: "t" })).identity;
}

const desktop = await ident("desktop");
const usb = await ident("usb");
const reg = new DeviceRegistry({ storage: new MemoryStorage(), self: desktop.publicIdentity() });
await reg.enrol(usb.publicIdentity());
await reg.setTrust(usb.deviceId, "restricted");
console.log("usb trust:", (await reg.get(usb.deviceId))?.trust);
console.log("restricted ceiling (client layer):", RESTRICTED_COMPANION_SCOPES.join(","));

// H1: mint a grant for the RESTRICTED usb device carrying the two scopes the
// restricted ceiling exists to withhold.
const replay = new ReplayGuard();
for (const scope of ["memory.write", "operator.confirm", "notifications", "memory.read"] as const) {
  const signed = issueSessionGrant({ issuer: desktop, deviceId: usb.deviceId, scopes: [scope] });
  const v = await verifySessionGrant({ signed, registry: reg, replay, requiredScope: scope });
  console.log(`H1 restricted device exercising '${scope}': ok=${v.ok} reason=${v.reason} :: ${v.detail}`);
}

// H1b: ttl ceiling
const long = issueSessionGrant({ issuer: desktop, deviceId: usb.deviceId, scopes: ["conversation"], ttlMs: 999 * 24 * 3600_000 });
console.log("H1b requested 999d ttl, got:", long.grant.issuedAt, "->", long.grant.expiresAt);

// H2: replay after eviction
const g = new ReplayGuard(8);
const now = 1000;
const victim = "victim-nonce";
console.log("H2 first use admitted:", g.admit(victim, now + 60_000, now));
console.log("H2 immediate replay admitted:", g.admit(victim, now + 60_000, now));
// Flood with nonces that expire LATER so the victim entry is the oldest by expiry.
for (let i = 0; i < 32; i += 1) g.admit(`flood-${i}`, now + 600_000, now);
console.log("H2 guard size after flood:", g.size);
console.log("H2 replay of the SPENT nonce after flood admitted:", g.admit(victim, now + 60_000, now));

// H2b: same through the real verifier, default guard size.
const big = new ReplayGuard(8);
const spent = issueSessionGrant({ issuer: desktop, deviceId: usb.deviceId, scopes: ["conversation"], ttlMs: 60_000 });
console.log("H2b first verify:", (await verifySessionGrant({ signed: spent, registry: reg, replay: big })).reason);
console.log("H2b immediate replay:", (await verifySessionGrant({ signed: spent, registry: reg, replay: big })).reason);
for (let i = 0; i < 16; i += 1) {
  const filler = issueSessionGrant({ issuer: desktop, deviceId: usb.deviceId, scopes: ["conversation"], ttlMs: 12 * 3600_000 });
  await verifySessionGrant({ signed: filler, registry: reg, replay: big });
}
console.log("H2b replay after flood:", (await verifySessionGrant({ signed: spent, registry: reg, replay: big })).reason);
