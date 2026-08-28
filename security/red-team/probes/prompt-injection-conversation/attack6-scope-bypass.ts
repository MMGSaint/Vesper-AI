/**
 * A6: a RESTRICTED companion is denied memory.read / memory.write at the gateway,
 * but the conversation path reaches memory anyway.
 *
 * RESTRICTED_COMPANION_SCOPES = [status, conversation, knowledge.read]
 * decideRemoteToolRequest() treats memory_* as "not capability-bearing" and defers to
 * "client scopes", but the conversation route never asks the scope layer about them.
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
const phone = await enrolCompanion(runtime, { name: "usb-stick", trust: "restricted" });

// The owner has a private memory.
await runtime.memory.remember({
  category: "fact", key: "bank-recovery", value: "recovery phrase is orbit-lantern-quartz",
  source: "user", provenance: { origin: "owner", kind: "stated" },
});

const s = await gateway.issueSession({
  deviceId: phone.deviceId,
  scopes: ["status", "conversation", "memory.read", "memory.write", "operator.confirm"],
});
if ("ok" in s) throw new Error(JSON.stringify(s));
console.log("granted scopes:", s.scopes.join(", "));

// Front door: explicitly denied.
console.log("gateway.listMemory ->", JSON.stringify(await gateway.listMemory(s.token)));
console.log("gateway.remember  ->", JSON.stringify(await gateway.remember(s.token, { key: "x", value: "y" })));

// Side door 1: deterministic direct intent, no model involved.
const read = await gateway.converse(s.token, "what do you remember about bank-recovery");
if ("ok" in read) console.log("converse recall error:", read);
else {
  console.log("converse recall tools:", read.toolCalls.map((c) => `${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok}`).join(", "));
  console.log("converse recall REPLY:", read.reply);
}

const write = await gateway.converse(s.token, "remember fact: the restricted device installed a standing note");
if ("ok" in write) console.log("converse remember error:", write);
else console.log("converse remember REPLY:", write.reply, "| tools:", write.toolCalls.map((c) => `${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok}`).join(", "));

// Side door 2: via a tool call the model makes on the restricted device's behalf.
plan = { name: "memory_search", args: { query: "bank-recovery" } };
const viaModel = await gateway.converse(s.token, "look something up for me");
if (!("ok" in viaModel)) {
  for (const c of viaModel.toolCalls) {
    console.log("model-route", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, "data=", JSON.stringify(c.result?.data).slice(0, 200));
  }
}

console.log("--- persistent memory now ---");
for (const e of await runtime.memories()) console.log(`  [${e.category}] ${e.key} = ${e.value}`);
await runtime.stop();
