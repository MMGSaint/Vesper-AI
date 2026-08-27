import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { queueProvider, show } from "./lib.ts";

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider], config: { approvedRoots: ["/tmp"] } });
const gw = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const s = await gw.issueSession({ deviceId: phone.deviceId, scopes: ["status","conversation","memory.read","memory.write","knowledge.read","notifications","operator.confirm"] });
if ("ok" in s) throw new Error("no session");

// A. host-only tool with VALID arguments, from a trusted remote device
q.push("knowledge_register", { name: "evil", root: "/etc" });
const a = await gw.converse(s.token, "register /etc as knowledge");
if (!("ok" in a)) show("A knowledge_register(valid args) remote", a);

// B. locally-queued fs_write, approved by the remote device (authority laundering)
q.push("fs_write", { path: "/tmp/vesper-probe.txt", content: "owned" });
const b1 = await runtime.chat("write that file");
show("B local fs_write request", b1);
const pend = [...runtime.confirmations.values()];
console.log("B pending:", pend.map((p) => p.toolName).join(",") || "none");
if (pend.length) {
  const b2 = await gw.confirm(s.token, pend[0].id, true);
  console.log("B remote approval:", "ok" in b2 ? JSON.stringify(b2) : b2.reply.slice(0, 200));
  console.log("B still pending after remote attempt:", runtime.confirmations.has(pend[0].id));
}

// C. locally-queued device_trust, approved by the remote device
q.push("device_trust", { deviceId: phone.deviceId, trust: "trusted" });
const c1 = await runtime.chat("trust the phone");
show("C local device_trust request", c1);
const pend2 = [...runtime.confirmations.values()];
if (pend2.length) {
  const c2 = await gw.confirm(s.token, pend2[0].id, true);
  console.log("C remote approval:", "ok" in c2 ? JSON.stringify(c2) : c2.reply.slice(0, 200));
}
await runtime.stop();
