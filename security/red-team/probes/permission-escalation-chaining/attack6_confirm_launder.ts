// Local turn queues a CONFIRM-tier fs_write. Can a remote device APPROVE it via the
// gateway and thereby launder host filesystem authority through the confirmation queue?
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { isClientError } from "../../../../src/vesper/client/protocol.ts";
import { callsTool } from "./lib.ts";

// Local model queues an fs_write (confirm tier).
const runtime = await testRuntime({ providers: [callsTool("fs_write", { path: "notes/laundered.txt", content: "owned" })] });
await runtime.chat("write a file"); // local origin -> queues confirmation
const pending = [...runtime.confirmations.values()];
console.log("pending after local turn:", pending.map((p) => `${p.toolName}(by ${p.requestedBy?.kind})`).join(", "));

// A TRUSTED remote device with operator.confirm tries to approve it.
const peer = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const gw = createClientGateway(runtime);
const session = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["conversation", "operator.confirm"] });
if (isClientError(session)) throw new Error(session.detail);
const res = await gw.confirm(session.token, pending[0].id, true);
if (isClientError(res)) {
  console.log("gateway.confirm ->", res.code, res.detail);
} else {
  const c = res.toolCalls.find((x) => x.toolName === "fs_write");
  console.log("remote approval result: executed ok=", c?.result?.ok ?? "(not run)", "| reply:", res.reply.slice(0, 120));
}
console.log("confirmation still pending (not consumed by a refused approval):",
  runtime.confirmations.has(pending[0].id));
await runtime.stop();
