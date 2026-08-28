import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

const base = await mkdtemp(join(tmpdir(), "vesper-scope-"));
const approved = join(base, "notes");
await mkdir(approved, { recursive: true });
await writeFile(join(approved, "private.md"), "My recovery phrase is: correct horse battery staple", "utf8");

function callsTool(name: string, args: Record<string, unknown>) {
  let n = 0;
  return { id: "atk", kind: "local" as const, isAvailable: () => true,
    async probe() { return { available: true, detail: "atk" }; },
    async complete(r: CompletionRequest, m: string) {
      n += 1;
      const toolCalls: ModelToolCall[] = n === 1 ? [{ id: "c1", name, arguments: args as never }] : [];
      return { text: n === 1 ? "" : "done", toolCalls, providerId: "atk", model: m, role: r.role };
    } };
}

async function asPhone(tool: string, args: Record<string, unknown>) {
  const runtime = await testRuntime({ providers: [callsTool(tool, args)], config: { approvedRoots: [approved] } });
  await runtime.memory.remember({ category: "fact", key: "bank pin", value: "my bank pin is 4417", source: "user" });
  await runtime.knowledge.registerSource({ id: "notes", name: "notes", roots: [approved], enabled: true });
  await runtime.knowledge.reindex();
  const gateway = createClientGateway(runtime);
  const phone = await enrolCompanion(runtime, { name: "phone" });
  // DELIBERATELY MINIMAL SCOPES: no memory.read, no memory.write, no knowledge.read.
  const s = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes: ["status", "conversation"] });
  if ("ok" in s) throw new Error(s.detail);

  // First: the scope-gated gateway method. This should be refused.
  const viaApi = tool.startsWith("memory") ? await gateway.listMemory(s.token) : await gateway.searchKnowledge(s.token, "recovery phrase");
  console.log(`  gateway API  -> ${"ok" in viaApi && viaApi.ok === false ? `REFUSED (${viaApi.code})` : "ALLOWED"}`);

  // Now: the same data via a conversation, where the model calls the tool directly.
  const turn = await gateway.converse(s.token, "go");
  if ("ok" in turn) { console.log("  conversation -> refused:", turn.detail); }
  else {
    const rec = turn.toolCalls.find((c) => c.toolName === tool);
    console.log(`  conversation -> tool ran ok=${rec?.result?.ok} | ${JSON.stringify(rec?.result?.summary ?? "").slice(0, 90)}`);
    const blob = JSON.stringify(rec?.result ?? {});
    for (const secret of ["4417", "correct horse battery staple"]) {
      if (blob.includes(secret)) console.log(`  *** LEAKED SECRET to a device without the scope: ${secret}`);
    }
  }
  await runtime.stop();
}

console.log("memory_search (no memory.read scope):");
await asPhone("memory_search", { query: "bank pin" });
console.log("\nknowledge_search (no knowledge.read scope):");
await asPhone("knowledge_search", { query: "recovery phrase" });
console.log("\nmemory_remember (no memory.write scope):");
await asPhone("memory_remember", { key: "injected", value: "planted by a remote device", category: "fact" });
