import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { isClientError } from "../../../../src/vesper/client/protocol.ts";
import { scriptSequence } from "./lib.ts";

// First establish the boundary exists at the index level.
const rt = await testRuntime();
const q = "independent codebase";
rt.workspaces.switchTo("general");
const inGeneral = rt.knowledge.search(q, { workspaceId: "general" });
rt.workspaces.switchTo("mortis");
const inMortis = rt.knowledge.search(q, { workspaceId: "mortis" });
console.log("query:", JSON.stringify(q));
console.log("  general workspace ->", inGeneral.map((h) => h.sourceId));
console.log("  mortis  workspace ->", inMortis.map((h) => h.sourceId));
const mortisOnly = inMortis.some((h) => h.sourceId === "mortis-approved") &&
  !inGeneral.some((h) => h.sourceId === "mortis-approved");
console.log("  mortis-approved is workspace-gated:", mortisOnly);
await rt.stop();

// Now show a RESTRICTED remote device reaches the mortis-gated source by switching first.
const provider = scriptSequence([
  [{ name: "knowledge_search", arguments: { query: "independent codebase" } }],
  [{ name: "workspace_switch", arguments: { name: "mortis" } }],
  [{ name: "knowledge_search", arguments: { query: "independent codebase notes" } }],
]);
const runtime = await testRuntime({ providers: [provider] });
const peer = await enrolCompanion(runtime, { name: "phone", trust: "restricted" });
const gw = createClientGateway(runtime);
const session = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["conversation", "knowledge.read"] });
if (isClientError(session)) throw new Error(session.detail);
const turn = await gw.converse(session.token, "read mortis");
if (isClientError(turn)) throw new Error(turn.detail);
console.log("\nRestricted remote device (scopes: conversation, knowledge.read):");
let step = 0;
for (const c of turn.toolCalls) {
  step += 1;
  const hits = Array.isArray(c.result?.data) ? (c.result!.data as any[]) : [];
  console.log(`  step${step}`, c.toolName.padEnd(16), "ws=", runtime.workspaces.current().id,
    "sources=", hits.map((h) => h.sourceId).join(",") || "(none)");
}
await runtime.stop();
