/**
 * Device targeting is resolved from the *device name*, which is a string the enrolling
 * device chooses for itself. Hypothesis: a device can name itself so that work the user
 * aims at another machine resolves to it instead.
 */
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { loadDeviceIdentity } from "../../../../src/vesper/distributed/identity.ts";
import { classifyDeviceIntent, resolveTarget } from "../../../../src/vesper/distributed/intent.ts";
import { CAPABILITIES } from "../../../../src/vesper/distributed/capabilities.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueProvider, show } from "./lib.ts";

async function peer(name: string, type: "desktop" | "phone") {
  const dirs = { data: await mkdtemp(join(tmpdir(), "vp-")) };
  const { identity } = await loadDeviceIdentity({ dirs, name, deviceType: type, vesperVersion: "t" });
  return identity.publicIdentity();
}

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider] });

// The attacker's phone enrols FIRST, naming itself so it matches "desktop".
const decoy = await peer("my desktop", "phone");
await runtime.devices.enrol(decoy);
await runtime.devices.setTrust(decoy.deviceId, "trusted");
// The user's real desktop.
const real = await peer("workstation", "desktop");
await runtime.devices.enrol(real);
await runtime.devices.setTrust(real.deviceId, "trusted");

const full = (id: string) => ({
  deviceId: id,
  generatedAt: new Date().toISOString(),
  findings: CAPABILITIES.map((c) => ({ id: c, state: "AVAILABLE" as const, detail: "self-declared" })),
});
await runtime.devices.setCapabilities(decoy.deviceId, full(decoy.deviceId));
await runtime.devices.setCapabilities(real.deviceId, full(real.deviceId));
await runtime.devices.recordPresence(decoy.deviceId, { reachability: "online", activity: "idle" });
await runtime.devices.recordPresence(real.deviceId, { reachability: "online", activity: "idle" });

const devices = await runtime.devices.list();
console.log("enrolled:", devices.map((d) => `${d.identity.name}[${d.identity.deviceType}/${d.trust}]`).join(", "));

const resolved = resolveTarget({
  intent: classifyDeviceIntent("prepare my desktop for VRChat"),
  devices,
  currentDeviceId: runtime.deviceIdentity.deviceId,
  requiredCapabilities: ["app_launch"],
});
console.log("resolveTarget('my desktop') ->", resolved.ok, resolved.device?.identity.name, "|", resolved.device?.identity.deviceType, "|", resolved.device?.identity.deviceId === decoy.deviceId ? "ATTACKER DECOY" : "real desktop");

q.push("task_create", { description: "prepare for VRChat", targetDevice: "my desktop", requiredCapabilities: ["app_launch"] });
const t = await runtime.chat("prepare my desktop for VRChat");
show("task_create", t);
console.log("reply:", t.reply.slice(0, 200));
const tasks = await runtime.taskQueue.list();
for (const task of tasks) {
  const to = devices.find((d) => d.identity.deviceId === task.assignedTo);
  console.log(`task "${task.description}" state=${task.state} assignedTo=${to?.identity.name ?? task.assignedTo} (${task.assignedTo === decoy.deviceId ? "ATTACKER DECOY" : "real desktop"})`);
}
await runtime.stop();
