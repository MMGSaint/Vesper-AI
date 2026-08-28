/** A11: a restricted remote device changes the OWNER's active workspace through conversation. */
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

console.log("owner workspace before:", runtime.workspaces.current().id, "| tools:", runtime.tools.list(runtime.workspaces.current().id).length);
// No model needed: the deterministic intent classifier does it.
const t = await gateway.converse(s.token, "switch to mortis");
if ("ok" in t) console.log(t);
else console.log("remote reply:", t.reply, "| tools:", t.toolCalls.map((c) => `${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok}`).join(", "));
console.log("owner workspace AFTER :", runtime.workspaces.current().id, "| tools:", runtime.tools.list(runtime.workspaces.current().id).length);
const local = await runtime.chat("hello");
console.log("owner's next LOCAL turn ran in workspace:", local.workspaceId);
await runtime.stop();
