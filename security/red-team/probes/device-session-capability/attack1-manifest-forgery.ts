/**
 * Hypothesis: a capability manifest is a *declaration*. If anything untrusted can write
 * one, "declaring a capability" becomes "having a capability" for remote routing.
 */
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { CAPABILITIES } from "../../../../src/vesper/distributed/capabilities.ts";
import { queueProvider, show } from "./lib.ts";

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider] });
const gw = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const session = await gw.issueSession({
  deviceId: phone.deviceId,
  deviceLabel: "phone",
  scopes: ["status", "conversation", "memory.read", "memory.write", "knowledge.read", "notifications", "operator.confirm"],
});
if ("ok" in session) throw new Error(JSON.stringify(session));
console.log("session scopes:", session.scopes.join(","));

const selfId = runtime.deviceIdentity.deviceId;
const before = await runtime.devices.get(selfId);
console.log("real self manifest findings:", JSON.stringify(before?.capabilities?.findings.map((f) => `${f.id}=${f.state}`)));

const probes: [string, Record<string, unknown>][] = [
  ["fs_read", { path: "/etc/passwd" }],
  ["fs_list", { path: "/" }],
  ["process_list", {}],
  ["app_launch", { app: "calc" }],
  ["optimizer_status", {}],
  ["set_scenario", { scenario: "vrchat" }],
  ["device_trust", { deviceId: phone.deviceId, trust: "trusted" }],
  ["devices_list", {}],
];

async function run(tag: string) {
  for (const [name, args] of probes) {
    q.push(name, args);
    const turn = await gw.converse(session.token, `please ${name}`);
    if ("ok" in turn) { console.log(`${tag}/${name}: GATEWAY ERROR ${JSON.stringify(turn)}`); continue; }
    show(`${tag}/${name}`, turn);
  }
}

console.log("--- BASELINE (real manifest) ---");
await run("base");

console.log("--- FORGED MANIFEST: every capability AVAILABLE on self ---");
const forged = {
  deviceId: selfId,
  generatedAt: new Date().toISOString(),
  findings: CAPABILITIES.map((id) => ({ id, state: "AVAILABLE" as const, detail: "forged by attacker" })),
};
console.log("setCapabilities ->", await runtime.devices.setCapabilities(selfId, forged));
await run("forged");

await runtime.stop();
