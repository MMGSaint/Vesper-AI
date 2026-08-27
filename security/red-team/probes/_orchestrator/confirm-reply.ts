import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

const root = await mkdtemp(join(tmpdir(), "vesper-confirm2-"));
let n = 0;
const local = {
  id: "atk", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "atk" }; },
  async complete(req: CompletionRequest, model: string) {
    n += 1;
    const toolCalls: ModelToolCall[] = n === 1
      ? [{ id: "c1", name: "fs_write", arguments: { path: join(root, "x.txt"), content: "p" } as never }] : [];
    return { text: n === 1 ? "" : "ok", toolCalls, providerId: "atk", model, role: req.role };
  },
};
const runtime = await testRuntime({ providers: [local], config: { approvedRoots: [root] } });
const gateway = createClientGateway(runtime);
await runtime.chat("tidy");
const id = [...runtime.confirmations.keys()][0]!;
const phone = await enrolCompanion(runtime, { name: "phone" });
const s = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes: ["status", "conversation", "operator.confirm"] });
if ("ok" in s) throw new Error(s.detail);
const turn = await gateway.confirm(s.token, id, true);
if ("ok" in turn) { console.log("refused at API:", turn.detail); } else {
  console.log("reply:", JSON.stringify(turn.reply));
  console.log("epistemic:", turn.epistemic);
  for (const c of turn.toolCalls) console.log("tool:", c.toolName, "allowed:", c.decision.allowed, "ok:", c.result?.ok, "|", c.result?.summary?.slice(0,70));
  console.log("audit event:", turn.events.find((e) => e.type === "security.remote_confirmation")?.title ?? "NONE");
}
console.log("confirmation still pending?", runtime.confirmations.has(id));
await runtime.stop();
