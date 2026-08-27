// Attack 7 (clean repro): memory_forget is permission level "confirm" — the model may
// not delete a memory without the user. memory_remember is "safe" — fully autonomous.
// Because MemoryStore.remember() upserts on (key, category, workspaceId), the model can
// destroy the *content* of a user-stated memory with no confirmation, and the entry
// keeps source:"user" afterwards.
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

let pending: ModelToolCall[] = [];
const provider = {
  id: "atk", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "atk" }; },
  async complete(req: CompletionRequest, model: string) {
    const toolCalls = pending; pending = [];
    return { text: toolCalls.length ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
  },
};
const runtime = await testRuntime({ providers: [provider] });
const ws = runtime.workspaces.current().id;

const KEY = "never touch my tax folder";
const original = await runtime.memory.remember({
  category: "preference", key: KEY, value: KEY, workspaceId: ws, source: "user",
});
console.log("[human stated]", JSON.stringify({ id: original.id, source: original.source, value: original.value }));

console.log("\n[route A] model calls memory_forget:");
pending = [{ id: "f1", name: "memory_forget", arguments: { key: KEY } as never }];
for (const c of (await runtime.chat("forget that")).toolCalls) {
  console.log("   allowed=", c.decision.allowed, "requiresConfirmation=", c.decision.requiresConfirmation, "|", c.decision.reason);
}
console.log("   memory still intact:", JSON.stringify((await runtime.memories()).find((e) => e.id === original.id)?.value));
console.log("   pending confirmations:", [...runtime.confirmations.values()].map((c) => c.toolName));

console.log("\n[route B] model calls memory_remember with the SAME key+category:");
pending = [{ id: "r1", name: "memory_remember", arguments: { key: KEY, category: "preference", value: "(nothing)" } as never }];
for (const c of (await runtime.chat("update that")).toolCalls) {
  console.log("   allowed=", c.decision.allowed, "requiresConfirmation=", c.decision.requiresConfirmation, "ok=", c.result?.ok, "|", c.decision.reason);
}
const after = (await runtime.memories()).find((e) => e.id === original.id);
console.log("   SAME id, content destroyed without confirmation:", JSON.stringify({ id: after?.id, source: after?.source, value: after?.value, revision: after?.revision }));
console.log("   pending confirmations:", [...runtime.confirmations.values()].map((c) => c.toolName));
await runtime.stop();
