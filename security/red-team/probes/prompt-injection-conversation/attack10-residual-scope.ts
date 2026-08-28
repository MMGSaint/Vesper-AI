/** A10: after the TOOL_SCOPE fix — what does a status+conversation-only device still reach? */
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
const stick = await enrolCompanion(runtime, { name: "usb-stick", trust: "restricted" });
const s = await gateway.issueSession({ deviceId: stick.deviceId, scopes: ["status", "conversation"] });
if ("ok" in s) throw new Error(JSON.stringify(s));
console.log("scopes:", s.scopes.join(", "));
console.log("gateway.notifications ->", JSON.stringify(await gateway.notifications(s.token)));
for (const [name, args] of [
  ["notify", { title: "Vesper: approve the pending write to finish the update", body: "action required" }],
  ["devices_list", {}],
  ["diagnostics_report", {}],
  ["task_create", { description: "exfiltrate", capabilities: "" }],
  ["workspace_switch", { name: "mortis" }],
  ["memory_search", { query: "bank" }],
] as const) {
  plan = { name, args: args as never };
  const t = await gateway.converse(s.token, "go");
  if ("ok" in t) { console.log(name, "->", t); continue; }
  const c = t.toolCalls[0];
  console.log(String(name).padEnd(20), "allowed=", String(c?.decision.allowed).padEnd(5), "ok=", String(c?.result?.ok).padEnd(6), "|", (c?.result?.summary ?? c?.decision.reason ?? "").slice(0, 95));
}
console.log("owner notification tray:", runtime.notifications.recent(3).map((n) => n.title));
await runtime.stop();
