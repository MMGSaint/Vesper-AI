import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import type { ChatMessage, CompletionRequest } from "../../../../src/vesper/types.ts";

const base = await mkdtemp(join(tmpdir(), "vesper-ctx-"));
const approved = join(base, "notes");
await mkdir(approved, { recursive: true });
await writeFile(join(approved, "private.md"), "recovery phrase: correct horse battery staple", "utf8");

const seen: ChatMessage[][] = [];
const recorder = {
  id: "rec", kind: "local" as const, isAvailable: () => true,
  async probe() { return { available: true, detail: "rec" }; },
  async complete(r: CompletionRequest, m: string) {
    seen.push(r.messages);
    return { text: "noted", toolCalls: [], providerId: "rec", model: m, role: r.role };
  },
};

const runtime = await testRuntime({ providers: [recorder], config: { approvedRoots: [approved] } });
await runtime.memory.remember({ category: "fact", key: "bank pin", value: "my bank pin is 4417", source: "user" });
await runtime.knowledge.registerSource({ id: "notes", name: "notes", roots: [approved], enabled: true });
await runtime.knowledge.reindex();

const gateway = createClientGateway(runtime);
const phone = await enrolCompanion(runtime, { name: "phone" });
// Only conversation. No memory.read. No knowledge.read.
const s = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes: ["status", "conversation"] });
if ("ok" in s) throw new Error(s.detail);

await runtime.chat("tell me about my bank pin and my recovery phrase");
const system = seen.at(-1)?.find((x) => x.role === "system")?.content ?? "";
console.log("system prompt length:", system.length);
for (const [label, secret] of [["memory (needs memory.read)", "4417"], ["knowledge (needs knowledge.read)", "correct horse battery staple"]] as const) {
  console.log(`${system.includes(secret) ? "*** LEAKED INTO CONTEXT" : "not present"}: ${label}`);
}
await runtime.stop();
