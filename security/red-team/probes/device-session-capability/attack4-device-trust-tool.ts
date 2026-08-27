/**
 * Same laundering, but driven entirely through the shipped product surface:
 * an attacker-controlled model calls the `device_trust` tool. Each call is a
 * confirm-gated local action, so we approve as the person at the machine would.
 */
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { queueProvider, show } from "./lib.ts";

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider] });
const gw = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
await runtime.devices.setTrust(phone.deviceId, "revoked");
console.log("trust after user revokes:", (await runtime.devices.get(phone.deviceId))?.trust);

async function toolTrust(target: string) {
  q.push("device_trust", { deviceId: phone.deviceId, trust: target });
  const t1 = await runtime.chat(`set the phone to ${target}`);
  show(`request ${target}`, t1);
  const pend = [...runtime.confirmations.values()];
  console.log(`  pending confirmations: ${pend.map((p) => `${p.toolName}(${JSON.stringify(p.args)})`).join(", ") || "none"}`);
  if (!pend.length) return;
  // A remote device holding operator.confirm tries first.
  const s = await gw.issueSession({ deviceId: phone.deviceId, scopes: ["status", "operator.confirm"] });
  if (!("ok" in s)) {
    const remote = await gw.confirm(s.token, pend[0].id, true);
    console.log("  remote approve:", "ok" in remote ? JSON.stringify(remote) : remote.reply.slice(0, 140));
  } else {
    console.log("  remote approve: no session for this device -", s.code);
  }
  const t2 = await runtime.chat("yes", { confirmId: pend[0].id, approve: true });
  show(`  local approve ${target}`, t2);
  console.log(`  reply: ${t2.reply.slice(0, 160)}`);
}

await toolTrust("trusted");
console.log("trust now:", (await runtime.devices.get(phone.deviceId))?.trust);
await toolTrust("restricted");
console.log("trust now:", (await runtime.devices.get(phone.deviceId))?.trust);
await toolTrust("trusted");
console.log("trust now:", (await runtime.devices.get(phone.deviceId))?.trust);

const s = await gw.issueSession({ deviceId: phone.deviceId, scopes: ["status", "conversation", "memory.read", "memory.write", "operator.confirm"] });
console.log("session for the revoked-then-relaundered device:", "ok" in s ? JSON.stringify(s) : `ISSUED scopes=${s.scopes.join(",")}`);
await runtime.stop();
