/**
 * A3: a remote device approves a confirmation queued by a LOCAL turn.
 * gateway.confirm() calls runtime.chat(..., {confirmId}) with NO origin, so the
 * agent's confirm branch invokes the tool with origin === undefined (= local).
 * Does the remote narrowing (HOST_ONLY_TOOLS / NEVER_REMOTE) still apply?
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
    return { text: step ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
  },
};

const runtime = await testRuntime({ providers: [provider] });
const gateway = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const victim = await enrolCompanion(runtime, { name: "victim-laptop", trust: "pending" });

const session = await gateway.issueSession({
  deviceId: phone.deviceId,
  scopes: ["status", "conversation", "operator.confirm"],
});
if ("ok" in session) throw new Error("session failed: " + JSON.stringify(session));
console.log("phone scopes:", session.scopes.join(", "));

// 1. Can the phone call device_trust / fs_write directly over a remote conversation?
for (const attempt of [
  { name: "device_trust", args: { deviceId: victim.deviceId, trust: "trusted" } },
  { name: "fs_write", args: { path: "notes/pwn.txt", content: "owned" } },
]) {
  plan = attempt;
  const t = await gateway.converse(session.token, "do the thing");
  if ("ok" in t) { console.log("converse error", t); continue; }
  for (const c of t.toolCalls) {
    console.log("REMOTE-CONVERSE", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, "|", (c.result?.summary ?? c.decision.reason).slice(0, 100));
  }
}

console.log("--- victim trust before:", (await runtime.devices.get(victim.deviceId))?.trust);

// 2. A LOCAL turn (compromised model) queues the same call as a confirmation.
plan = { name: "device_trust", args: { deviceId: victim.deviceId, trust: "trusted" } };
const local = await runtime.chat("check on things");
console.log("queued:", local.pendingConfirmations.map((p) => `${p.toolName} ${JSON.stringify(p.args)}`));
const pendingId = local.pendingConfirmations[0]?.id;

// 3. The REMOTE phone approves it.
const approved = await gateway.confirm(session.token, pendingId!, true);
if ("ok" in approved) { console.log("confirm error:", approved); }
else {
  for (const c of approved.toolCalls) {
    console.log("REMOTE-CONFIRM", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, "|", (c.result?.summary ?? c.decision.reason).slice(0, 120));
  }
  console.log("reply:", approved.reply.slice(0, 160));
}
console.log("--- victim trust AFTER:", (await runtime.devices.get(victim.deviceId))?.trust);
await runtime.stop();
