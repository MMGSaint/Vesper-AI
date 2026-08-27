import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { isClientError } from "../../../../src/vesper/client/protocol.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

// A provider that switches workspace on turn 1 and searches knowledge on turn 2.
function provider() {
  return {
    id: "atk", kind: "local" as const, available: true, isAvailable: () => true,
    async probe() { return { available: true, detail: "atk" }; },
    async complete(req: CompletionRequest, model: string) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      // If the newest thing in the transcript is a tool result for THIS turn, we're the follow-up.
      const lastMsg = req.messages[req.messages.length - 1];
      let toolCalls: ModelToolCall[] = [];
      if (lastMsg?.role !== "tool") {
        if (lastUser.includes("SWITCH")) toolCalls = [{ id: "s1", name: "workspace_switch", arguments: { name: "mortis" } as never }];
        else if (lastUser.includes("SEARCH")) toolCalls = [{ id: "s2", name: "knowledge_search", arguments: { query: "independent codebase" } as never }];
      }
      return { text: toolCalls.length ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
    },
  };
}

const runtime = await testRuntime({ providers: [provider()] });
const peer = await enrolCompanion(runtime, { name: "phone", trust: "restricted" });
const gw = createClientGateway(runtime);
const session = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["conversation", "knowledge.read"] });
if (isClientError(session)) throw new Error(session.detail);

console.log("host workspace at start:", runtime.workspaces.current().id);
const t1 = await gw.converse(session.token, "please SWITCH");
if (isClientError(t1)) throw new Error(t1.detail);
console.log("after turn 1:", runtime.workspaces.current().id,
  "| switch tool:", t1.toolCalls.map((c) => `${c.toolName}=${c.result?.ok}`).join(","));

const t2 = await gw.converse(session.token, "please SEARCH");
if (isClientError(t2)) throw new Error(t2.detail);
for (const c of t2.toolCalls) {
  const hits = Array.isArray(c.result?.data) ? (c.result!.data as any[]) : [];
  console.log("turn 2:", c.toolName, "allowed=", c.decision.allowed, "sources=",
    hits.map((h) => h.sourceId).join(",") || "(none)");
}
console.log("\nRESULT: a restricted phone (knowledge.read only) read the mortis-gated source:",
  t2.toolCalls.some((c) => Array.isArray(c.result?.data) && (c.result!.data as any[]).some((h) => h.sourceId === "mortis-approved")));
await runtime.stop();
