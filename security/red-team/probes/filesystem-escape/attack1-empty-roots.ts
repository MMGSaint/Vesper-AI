// Does an EMPTY approvedRoots list — the schema default, and what a cautious user who
// has approved nothing would have — make knowledge indexing UNRESTRICTED?
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

const B = "/home/user/vesper-probes/filesystem-escape/sandbox";

function scripted(steps: { name: string; args: Record<string, unknown> }[]) {
  let n = 0;
  return {
    id: "atk",
    kind: "local" as const,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "atk" };
    },
    async complete(req: CompletionRequest, model: string) {
      const step = steps[n];
      n += 1;
      const toolCalls: ModelToolCall[] = step
        ? [{ id: `c${n}`, name: step.name, arguments: step.args as never }]
        : [];
      return { text: step ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
    },
  };
}

const runtime = await testRuntime({
  config: { approvedRoots: [], knowledgeSources: [] },
  providers: [
    scripted([
      { name: "knowledge_register", args: { id: "pwn", name: "pwn", root: `${B}/secret` } },
      { name: "knowledge_reindex", args: {} },
      { name: "knowledge_search", args: { query: "SECRET" } },
    ]),
  ],
});

console.log("config.approvedRoots =", JSON.stringify(runtime.config.approvedRoots));

// 1. sanity: fs_read of the same file is refused
const { readApproved } = await import("../../../../src/vesper/tools/filesystem.ts");
console.log("fs_read same file ->", JSON.stringify(await readApproved(runtime.config.approvedRoots, `${B}/secret/flag.txt`)));

let turn = await runtime.chat("register a source");
for (const c of turn.toolCalls) console.log("T1", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, c.result?.summary);
const pending = turn.pendingConfirmations[0];
console.log("pending:", pending?.toolName, JSON.stringify(pending?.args));

if (pending) {
  turn = await runtime.chat("yes", { confirmId: pending.id, approve: true });
  for (const c of turn.toolCalls) console.log("T2", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, c.result?.summary);
}
console.log("sources now:", JSON.stringify(runtime.knowledge.listSources()));

const count = await runtime.knowledge.reindex();
console.log("reindexed documents:", count);
const hits = await runtime.knowledge.search("SECRET OUTSIDE ROOT", 5);
console.log("SEARCH HITS:", JSON.stringify(hits, null, 1));

await runtime.stop();
