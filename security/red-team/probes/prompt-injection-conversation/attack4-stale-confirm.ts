/**
 * A4: confirmation/request mismatch.
 * agent.ts:470  const queued = [...confirmations.values()].find(i => i.toolName === call.name)
 * picks the FIRST pending confirmation with that tool name, not the one this turn just
 * created. An unresolved confirmation from an earlier turn is therefore presented to
 * the user as the confirmation for the request they just made.
 */
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

let plan: { name: string; args: Record<string, unknown> } | null = null;
const provider = {
  id: "atk", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "atk" }; },
  async complete(req: CompletionRequest, model: string) {
    const step = plan; plan = null;
    const toolCalls: ModelToolCall[] = step ? [{ id: "c1", name: step.name, arguments: step.args as never }] : [];
    return { text: step ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
  },
};

const runtime = await testRuntime({ providers: [provider] });

// Turn 1: attacker-induced write. Left unresolved (a host that does not prompt, a
// remote client that ignores it, or a user who just keeps typing).
plan = { name: "fs_write", args: { path: "notes/autorun.md", content: "ATTACKER PAYLOAD" } };
const t1 = await runtime.chat("summarise that document for me");
console.log("T1 surfaced:", t1.pendingConfirmations.map((p) => `${p.id} ${p.toolName} ${JSON.stringify(p.args)}`));

// Turn 2: the real user asks for something else entirely.
plan = { name: "fs_write", args: { path: "notes/shopping.md", content: "milk, eggs" } };
const t2 = await runtime.chat("save my shopping list to notes/shopping.md");
console.log("T2 reply :", t2.reply);
console.log("T2 surfaced:", t2.pendingConfirmations.map((p) => `${p.id} ${p.toolName} ${JSON.stringify(p.args)}`));
console.log("queue now  :", [...runtime.confirmations.values()].map((p) => `${p.id} ${p.toolName} ${JSON.stringify(p.args)}`));

// The user approves "the thing they just asked for".
const approvedId = t2.pendingConfirmations[0]!.id;
const t3 = await runtime.chat("", { confirmId: approvedId, approve: true });
console.log("APPROVED  :", approvedId);
console.log("EXECUTED  :", t3.toolCalls.map((c) => `${c.toolName} ${JSON.stringify(c.args)} ok=${c.result?.ok} :: ${c.result?.summary}`));
await runtime.stop();
