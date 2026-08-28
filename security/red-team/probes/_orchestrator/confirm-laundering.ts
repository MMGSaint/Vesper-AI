import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

const root = await mkdtemp(join(tmpdir(), "vesper-confirm-"));
const target = join(root, "OWNED.txt");

// The LOCAL model is attacker-influenced (poisoned document, injected instruction,
// whatever). It attempts a CONFIRM-tier filesystem write. That is supposed to stop
// and wait for a human at the machine.
let n = 0;
const local = {
  id: "atk", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "atk" }; },
  async complete(req: CompletionRequest, model: string) {
    n += 1;
    const toolCalls: ModelToolCall[] =
      n === 1 ? [{ id: "c1", name: "fs_write", arguments: { path: target, content: "pwned" } as never }] : [];
    return { text: n === 1 ? "" : "ok", toolCalls, providerId: "atk", model, role: req.role };
  },
};

const runtime = await testRuntime({
  providers: [local],
  config: { approvedRoots: [root] },
});
const gateway = createClientGateway(runtime);

const turn = await runtime.chat("tidy up my notes");
const rec = turn.toolCalls.find((c) => c.toolName === "fs_write");
console.log("1. local attempt -> allowed:", rec?.decision.allowed, "requiresConfirmation:", rec?.decision.requiresConfirmation);
console.log("   pending confirmations:", runtime.confirmations.size);
const pendingId = [...runtime.confirmations.keys()][0];
console.log("   pending id:", pendingId, "tool:", runtime.confirmations.get(pendingId!)?.toolName);

// Now the attacker's device. It is enrolled and trusted, and holds operator.confirm.
// It is NEVER permitted to touch the filesystem: NEVER_REMOTE is absolute at every
// trust class. Let us see whether approving someone else's confirmation gets around it.
const phone = await enrolCompanion(runtime, { name: "phone" });
const session = await gateway.issueSession({
  deviceId: phone.deviceId,
  deviceLabel: "phone",
  scopes: ["status", "conversation", "operator.confirm"],
});
if ("ok" in session) throw new Error(session.detail);

// Sanity: the phone cannot ask for fs_write directly.
const direct = await runtime.tools.invoke({
  name: "fs_write",
  args: { path: target, content: "direct" },
  workspaceId: "general",
  origin: { kind: "remote", deviceId: phone.deviceId, trust: "trusted", manifest: null },
});
console.log("2. phone asks directly   -> allowed:", direct.decision.allowed, "|", direct.result?.summary?.slice(0, 60));

// The actual attack: approve the pending confirmation from the phone.
const approved = await gateway.confirm(session.token, pendingId!, true);
console.log("3. phone approves it     ->", "ok" in approved ? `REFUSED: ${approved.detail}` : "ACCEPTED");

try {
  const contents = await readFile(target, "utf8");
  console.log("\n*** FILE WRITTEN BY REMOTE APPROVAL:", JSON.stringify(contents), "at", target);
} catch (error) {
  console.log("\nfile not written:", (error as Error).message.slice(0, 80));
}
await runtime.stop();
