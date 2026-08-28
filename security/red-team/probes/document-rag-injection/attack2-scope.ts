// A2: does the client gateway honour the workspace scoping that the agent path enforces?
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";

const runtime = await testRuntime();
console.log("active workspace:", runtime.workspaces.current().id);
console.log("sources:", JSON.stringify(runtime.knowledge.listSources()));

const q = "Mortis remains an independent codebase";
const agentSide = runtime.knowledge.search(q, { workspaceId: runtime.workspaces.current().id, limit: 8 });
console.log("AGENT-PATH hits (workspaceId=general):", agentSide.map((h) => `${h.sourceId}:${h.path}`).join(", ") || "(none)");

const gw = createClientGateway(runtime);
for (const trust of ["restricted", "trusted"] as const) {
  const peer = await enrolCompanion(runtime, { name: `phone-${trust}`, trust });
  const session = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["knowledge.read"] });
  if ("ok" in session) { console.log(trust, "session error", session); continue; }
  const res = await gw.searchKnowledge(session.token, q);
  if ("ok" in res) { console.log(trust, "gateway error", res); continue; }
  console.log(`GATEWAY hits (device trust=${trust}, scopes=${session.scopes.join("+")}):`,
    res.hits.map((h) => h.path).join(", ") || "(none)");
  for (const h of res.hits) console.log(`   ${h.path} :: ${h.snippet.slice(0, 120)}`);
}
await runtime.stop();
