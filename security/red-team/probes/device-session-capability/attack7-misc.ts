import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { loadDeviceIdentity } from "../../../../src/vesper/distributed/identity.ts";
import { CAPABILITIES } from "../../../../src/vesper/distributed/capabilities.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueProvider, show } from "./lib.ts";

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider] });
const gw = createClientGateway(runtime);

// --- A. malformed / polluting identities through enrol ---
const cases: [string, unknown][] = [
  ["missing publicKey", { deviceId: "dev_x", deviceType: "phone", name: "x", os: "l", createdAt: "", vesperVersion: "t" }],
  ["bogus deviceType", { deviceId: "dev_y", deviceType: "root", name: "y", os: "l", publicKey: "AAA", createdAt: "", vesperVersion: "t" }],
  ["__proto__ trust", JSON.parse('{"deviceId":"dev_z","deviceType":"phone","name":"z","os":"l","publicKey":"AAA","createdAt":"","vesperVersion":"t","__proto__":{"trust":"trusted"}}')],
  ["empty deviceId", { deviceId: "", deviceType: "phone", name: "", os: "l", publicKey: "AAA", createdAt: "", vesperVersion: "t" }],
  ["trust smuggled in identity", { deviceId: "dev_w", deviceType: "phone", name: "w", os: "l", publicKey: "AAA", createdAt: "", vesperVersion: "t", trust: "trusted" }],
];
for (const [label, value] of cases) {
  const r = await runtime.devices.enrol(value as never);
  const after = await runtime.devices.get((value as { deviceId?: string }).deviceId ?? "");
  console.log(`A ${label}: ok=${r.ok} trust=${r.record?.trust ?? "-"} stored=${after?.trust ?? "-"} reason=${r.reason ?? "-"}`);
}
console.log("A proto check: ({}).trust =", (Object.prototype as unknown as { trust?: string }).trust);

// --- B. host-only tools from a trusted remote device ---
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const s = await gw.issueSession({ deviceId: phone.deviceId, scopes: ["status","conversation","memory.read","memory.write","knowledge.read","notifications","operator.confirm"] });
if ("ok" in s) throw new Error("no session");
for (const name of ["device_trust", "knowledge_register", "knowledge_remove", "knowledge_reindex"]) {
  q.push(name, name === "device_trust" ? { deviceId: phone.deviceId, trust: "trusted" } : { path: "/etc", id: "x" });
  const t = await gw.converse(s.token, `run ${name}`);
  if ("ok" in t) { console.log(`B ${name}: gateway ${JSON.stringify(t)}`); continue; }
  show(`B ${name}`, t);
}

// --- C. targetDevice pinning vs preferredDevice substitution when offline ---
async function peer(name: string, type: "desktop" | "laptop") {
  const dirs = { data: await mkdtemp(join(tmpdir(), "vp2-")) };
  const { identity } = await loadDeviceIdentity({ dirs, name, deviceType: type, vesperVersion: "t" });
  return identity.publicIdentity();
}
const desk = await peer("workstation", "desktop");
const lap = await peer("thinkpad", "laptop");
for (const p of [desk, lap]) {
  await runtime.devices.enrol(p);
  await runtime.devices.setTrust(p.deviceId, "trusted");
  await runtime.devices.setCapabilities(p.deviceId, {
    deviceId: p.deviceId, generatedAt: new Date().toISOString(),
    findings: CAPABILITIES.map((c) => ({ id: c, state: "AVAILABLE" as const, detail: "d" })),
  });
}
// desktop is OFFLINE (never heartbeats); laptop is online
await runtime.devices.recordPresence(lap.deviceId, { reachability: "online", activity: "idle" });
q.push("task_create", { description: "heavy job", targetDevice: "my desktop", requiredCapabilities: ["task_execute"] });
const t1 = await runtime.chat("run the heavy job on my desktop");
show("C targetDevice(offline desktop)", t1);
q.push("task_create", { description: "heavy job 2", preferredDevice: desk.deviceId, requiredCapabilities: ["task_execute"] });
const t2 = await runtime.chat("run heavy job 2");
show("C preferredDevice(offline desktop)", t2);
for (const task of await runtime.taskQueue.list()) {
  const to = (await runtime.devices.list()).find((d) => d.identity.deviceId === task.assignedTo);
  console.log(`C task "${task.description}" state=${task.state} assignedTo=${to?.identity.name ?? "-"}`);
}

// --- D. can a remote device revoke/forget or heartbeat another device? ---
console.log("D forget(self):", await runtime.devices.forget(runtime.deviceIdentity.deviceId));
console.log("D setTrust(self,'revoked'):", JSON.stringify((await runtime.devices.setTrust(runtime.deviceIdentity.deviceId, "revoked")).record?.trust));
const s2 = await gw.issueSession({ deviceId: runtime.deviceIdentity.deviceId, scopes: ["status"] });
console.log("D session as self after self-revoke:", "ok" in s2 ? s2.code : "ISSUED");

await runtime.stop();
