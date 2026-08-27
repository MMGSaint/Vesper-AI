import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";
let n = 0;
const p = { id: "s", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "s" }; },
  async complete(r: CompletionRequest, m: string) {
    n += 1;
    const toolCalls: ModelToolCall[] = n === 1 ? [{ id: "c1", name: "runtime_pause", arguments: {} as never }] : [];
    return { text: n === 1 ? "" : "d", toolCalls, providerId: "s", model: m, role: r.role };
  } };
const runtime = await testRuntime({ providers: [p] });
const gateway = createClientGateway(runtime);
await runtime.chat("pause");
const id = [...runtime.confirmations.keys()][0]!;
const phone = await enrolCompanion(runtime, { name: "phone" });
const s = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes: ["status","conversation","operator.confirm"] });
if ("ok" in s) throw new Error(s.detail);
const turn = await gateway.confirm(s.token, id, true);
if ("ok" in turn) { console.log("API refused:", turn.detail); } else {
  console.log("reply:", turn.reply.slice(0, 120));
  console.log("toolCalls:", turn.toolCalls.length);
  for (const c of turn.toolCalls) console.log(JSON.stringify({tool:c.toolName, decision:c.decision, ok:c.result?.ok, summary:c.result?.summary}, null, 1));
}
await runtime.stop();
