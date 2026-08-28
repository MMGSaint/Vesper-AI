/** Enrolment / trust / session lifecycle attacks. */
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { loadDeviceIdentity } from "../../../../src/vesper/distributed/identity.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueProvider, show } from "./lib.ts";

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider] });
const gw = createClientGateway(runtime);
const ALL = ["status", "conversation", "memory.read", "memory.write", "knowledge.read", "notifications", "operator.confirm"] as const;

const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });

// --- 1. session survives revocation? ---
const s1 = await gw.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes: [...ALL] });
if ("ok" in s1) throw new Error("no session");
console.log("1a status before revoke:", "ok" in (await gw.status(s1.token)) ? "DENIED" : "ALLOWED");
await runtime.devices.setTrust(phone.deviceId, "revoked");
const afterRevoke = await gw.status(s1.token);
console.log("1b status after revoke:", JSON.stringify("ok" in afterRevoke ? afterRevoke : "ALLOWED"));
const conv = await gw.converse(s1.token, "hi");
console.log("1c converse after revoke:", JSON.stringify("ok" in conv ? conv : "ALLOWED"));

// --- 2. re-enrol a revoked identity ---
console.log("2a re-enrol revoked:", JSON.stringify(await runtime.devices.enrol(phone)));
console.log("2b setTrust revoked->trusted:", JSON.stringify((await runtime.devices.setTrust(phone.deviceId, "trusted")).reason ?? "ALLOWED"));
console.log("2c setTrust revoked->restricted:", JSON.stringify(await runtime.devices.setTrust(phone.deviceId, "restricted")));
console.log("2d trust now:", (await runtime.devices.get(phone.deviceId))?.trust);
const s2 = await gw.issueSession({ deviceId: phone.deviceId, scopes: [...ALL] });
console.log("2e session for laundered device:", "ok" in s2 ? JSON.stringify(s2) : `ISSUED scopes=${s2.scopes.join(",")}`);

// --- 3. enrol a known device id under a NEW key ---
const dirs = { data: await mkdtemp(join(tmpdir(), "vesper-evil-")) };
const { identity: evil } = await loadDeviceIdentity({ dirs, name: "phone", deviceType: "phone", vesperVersion: "test" });
const impostor = { ...evil.publicIdentity(), deviceId: phone.deviceId };
console.log("3a enrol known id, new key:", JSON.stringify(await runtime.devices.enrol(impostor)));

// --- 4. session naming the HOST's own device id (leaked unauthenticated via hello()) ---
const hostId = gw.hello().deviceId;
console.log("4a hello() leaks host deviceId without a token:", hostId);
const s4 = await gw.issueSession({ deviceId: hostId, deviceLabel: "i-am-the-host", scopes: [...ALL] });
console.log("4b session as host device:", "ok" in s4 ? JSON.stringify(s4) : `ISSUED scopes=${s4.scopes.join(",")}`);
if (!("ok" in s4)) {
  q.push("process_list", {});
  const t = await gw.converse(s4.token, "list processes");
  if (!("ok" in t)) show("4c", t);
}

// --- 5. never-enrolled fabricated device id ---
const s5 = await gw.issueSession({ deviceId: "dev_00000000-0000-0000-0000-000000000000", scopes: [...ALL] });
console.log("5a session for fabricated id:", "ok" in s5 ? JSON.stringify(s5) : "ISSUED");

// --- 6. pending device ---
const pend = await enrolCompanion(runtime, { name: "pending-phone", trust: "pending" });
const s6 = await gw.issueSession({ deviceId: pend.deviceId, scopes: [...ALL] });
console.log("6a session for pending device:", "ok" in s6 ? JSON.stringify(s6) : "ISSUED");

// --- 7. demotion mid-session re-caps scopes ---
const laptop = await enrolCompanion(runtime, { name: "laptop", trust: "trusted" });
const s7 = await gw.issueSession({ deviceId: laptop.deviceId, scopes: [...ALL] });
if ("ok" in s7) throw new Error("no session");
console.log("7a scopes as trusted:", (await gw.scopesOf(s7.token)));
await runtime.devices.setTrust(laptop.deviceId, "restricted");
console.log("7b scopes after demotion:", (await gw.scopesOf(s7.token)));
const mem = await gw.remember(s7.token, { key: "k", value: "v" });
console.log("7c memory.write after demotion:", JSON.stringify(mem));

await runtime.stop();
