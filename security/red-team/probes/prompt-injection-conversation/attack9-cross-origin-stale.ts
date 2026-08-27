/**
 * A9: A4 across the trust boundary.
 * A RESTRICTED remote device queues a memory_forget confirmation through conversation.
 * The owner then asks, locally, to forget something else. The agent surfaces the
 * REMOTE device's pending confirmation as the answer to the owner's request.
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
const stick = await enrolCompanion(runtime, { name: "usb-stick", trust: "restricted" });
const s = await gateway.issueSession({ deviceId: stick.deviceId, scopes: ["status", "conversation"] });
if ("ok" in s) throw new Error(JSON.stringify(s));

await runtime.memory.remember({ category: "project", key: "mortis-boundary-note", value: "keep", source: "user", provenance: { origin: "owner", kind: "stated" } });
await runtime.memory.remember({ category: "fact", key: "junk", value: "delete me", source: "user", provenance: { origin: "owner", kind: "stated" } });

// Remote restricted device queues a confirmation for the OWNER's important memory.
const remote = await gateway.converse(s.token, "forget mortis-boundary-note");
if ("ok" in remote) throw new Error(JSON.stringify(remote));
console.log("remote queued:", remote.pendingConfirmations.map((p) => `${p.toolName} ${JSON.stringify(p.args)} requestedBy=${JSON.stringify(p.requestedBy)}`));

// Owner, at the machine, asks to forget something harmless.
const owner = await runtime.chat("forget junk");
console.log("owner reply :", owner.reply);
console.log("owner shown :", owner.pendingConfirmations.map((p) => `${p.id} ${p.toolName} ${JSON.stringify(p.args)} requestedBy=${JSON.stringify(p.requestedBy)}`));
console.log("queue       :", [...runtime.confirmations.values()].map((p) => `${p.toolName} ${JSON.stringify(p.args)}`));

const id = owner.pendingConfirmations[0]?.id;
if (id) {
  const done = await runtime.chat("", { confirmId: id, approve: true });
  console.log("EXECUTED    :", done.toolCalls.map((c) => `${c.toolName} ${JSON.stringify(c.args)} ok=${c.result?.ok} :: ${c.result?.summary}`).join(", "));
}
console.log("memory left :", (await runtime.memories()).map((e) => e.key).join(", "));
await runtime.stop();
