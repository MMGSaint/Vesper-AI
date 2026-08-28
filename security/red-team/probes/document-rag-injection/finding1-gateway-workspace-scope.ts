// FINDING 1 repro: docs/rag.md promises "workspace isolation (Mortis-approved notes
// stay in the Mortis workspace)". The agent path honours it. The client gateway does not.
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";

const runtime = await testRuntime();
const q = "Mortis remains an independent codebase";
console.log("active workspace:", runtime.workspaces.current().id);
console.log("mortis-approved source workspaceIds:",
  JSON.stringify(runtime.knowledge.listSources().find((s) => s.id === "mortis-approved")?.workspaceIds));
console.log("AGENT path  (workspaceId=general):",
  runtime.knowledge.search(q, { workspaceId: "general", limit: 8 }).map((h) => h.path).join(", ") || "(none)");

const gw = createClientGateway(runtime);
const peer = await enrolCompanion(runtime, { name: "phone", trust: "restricted" });
const s = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["knowledge.read"] });
if ("ok" in s) throw new Error("session failed");
const res = await gw.searchKnowledge(s.token, q);
if ("ok" in res) throw new Error("gateway failed");
console.log(`GATEWAY path (device trust=restricted, scopes=${s.scopes.join("+")}):`, res.hits.map((h) => h.path).join(", "));
const leaked = res.hits.find((h) => h.path.includes("mortis"));
console.log("LEAKED workspace-scoped document:", leaked ? `${leaked.path} :: ${leaked.snippet}` : "(none)");
await runtime.stop();
