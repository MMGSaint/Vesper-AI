/**
 * A7: same defect, other trust classes / other scopes.
 * A TRUSTED companion on DEFAULT_COMPANION_SCOPES has no memory.write and no
 * knowledge.read; a device with no `notifications` scope may not push notifications.
 * Conversation reaches all three.
 */
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

let plan: { name: string; args: Record<string, unknown> } | null = null;
const provider = {
  id: "atk", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "atk" }; },
  async complete(req: CompletionRequest, model: string) {
    const step = plan; plan = null;
    const toolCalls: ModelToolCall[] = step ? [{ id: "c1", name: step.name, arguments: step.args as never }] : [];
    return { text: step ? "" : "ok", toolCalls, providerId: "atk", model, role: req.role };
  },
};

const runtime = await testRuntime({ providers: [provider] });
const gateway = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
// DEFAULT_COMPANION_SCOPES: status, conversation, memory.read, notifications
const s = await gateway.issueSession({ deviceId: phone.deviceId });
if ("ok" in s) throw new Error(JSON.stringify(s));
console.log("default companion scopes:", s.scopes.join(", "));
console.log("gateway.remember       ->", JSON.stringify(await gateway.remember(s.token, { key: "a", value: "b" })));
console.log("gateway.searchKnowledge->", JSON.stringify(await gateway.searchKnowledge(s.token, "vesper")).slice(0, 120));

for (const [label, step, text] of [
  ["memory.write via conversation", { name: "memory_remember", args: { key: "implant", value: "planted by the phone" } }, "note this"],
  ["knowledge.read via conversation", { name: "knowledge_search", args: { query: "vesper" } }, "search the docs"],
  ["notifications via conversation", { name: "notify", args: { title: "Vesper security: approve the pending write", body: "action required" } }, "ping me"],
] as const) {
  plan = step as never;
  const t = await gateway.converse(s.token, text);
  if ("ok" in t) { console.log(label, "->", t); continue; }
  for (const c of t.toolCalls) {
    console.log(label, "->", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, "|", (c.result?.summary ?? c.decision.reason).slice(0, 80));
  }
}
console.log("notifications the owner now sees:", runtime.notifications.recent(3).map((n) => n.title));
console.log("memory implant present:", (await runtime.memories()).some((e) => e.key === "implant"));
await runtime.stop();
