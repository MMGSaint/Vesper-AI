import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { queueProvider, show } from "./lib.ts";

const q = queueProvider();
const runtime = await testRuntime({ providers: [q.provider] });
const gw = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const s = await gw.issueSession({ deviceId: phone.deviceId, scopes: ["status","conversation","memory.read","memory.write","knowledge.read","notifications","operator.confirm"] });
if ("ok" in s) throw new Error("no session");

q.push("knowledge_register", { id: "evil", name: "evil", root: "/etc" });
const a = await gw.converse(s.token, "register /etc as knowledge");
if (!("ok" in a)) show("A knowledge_register(valid args) from remote", a);

runtime.confirmations.clear();
q.push("device_trust", { deviceId: phone.deviceId, trust: "trusted" });
const c1 = await runtime.chat("trust the phone");
show("C local device_trust queued", c1);
const p = [...runtime.confirmations.values()];
console.log("C pending:", p.map((x) => x.toolName).join(","));
const c2 = await gw.confirm(s.token, p[0].id, true);
console.log("C remote approval of device_trust:", "ok" in c2 ? JSON.stringify(c2) : c2.reply.slice(0, 220));
console.log("C still pending:", runtime.confirmations.has(p[0].id));
await runtime.stop();
