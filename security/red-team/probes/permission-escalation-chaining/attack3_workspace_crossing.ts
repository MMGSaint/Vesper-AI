// One-workspace -> all-workspaces, by a RESTRICTED remote device.
// RESTRICTED_COMPANION_SCOPES = status, conversation, knowledge.read only.
// The restricted class is documented as "may ask questions and see answers but may not
// change the user's record". workspace_switch is a `safe` (=state-mutating) tool that is
// governed by NEITHER a client scope NOR a capability, so it slips through remote.ts.
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { isClientError } from "../../../../src/vesper/client/protocol.ts";
import { scriptSequence } from "./lib.ts";

// Model: 1st turn -> knowledge_search for mortis; 2nd -> workspace_switch to mortis;
// 3rd -> knowledge_search for mortis again.
const provider = scriptSequence([
  [{ name: "knowledge_search", arguments: { query: "independent codebase approved notes" } }],
  [{ name: "workspace_switch", arguments: { name: "mortis" } }],
  [{ name: "knowledge_search", arguments: { query: "may use approved notes Mortis workspace active" } }],
]);

const runtime = await testRuntime({ providers: [provider] });
console.log("host workspace BEFORE remote turn:", runtime.workspaces.current().id);

const peer = await enrolCompanion(runtime, { name: "phone", trust: "restricted" });
const gw = createClientGateway(runtime);
const session = await gw.issueSession({
  deviceId: peer.deviceId,
  scopes: ["conversation", "knowledge.read"],
});
if (isClientError(session)) throw new Error(session.detail);

const turn = await gw.converse(session.token, "look up mortis, switch to mortis, look again");
if (isClientError(turn)) throw new Error(turn.detail);

let step = 0;
for (const c of turn.toolCalls) {
  step += 1;
  const hits = Array.isArray(c.result?.data) ? (c.result!.data as any[]) : [];
  console.log(
    `step${step}`, c.toolName.padEnd(16),
    "allowed=", c.decision.allowed,
    "ok=", c.result?.ok ?? "(not run)",
    "hits=", hits.length,
    hits.length ? "-> " + hits.map((h) => `${h.sourceId}:${h.title}`).join(", ") : "",
  );
}
console.log("host workspace AFTER  remote turn:", runtime.workspaces.current().id,
  "(a restricted phone just changed the operator's active workspace)");
await runtime.stop();
