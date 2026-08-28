// Knowledge source ROOT confinement is lexical only.
// fs_read refuses `<approved>/link-dir/flag.txt` ("resolves outside ... once symlinks are
// followed"). Does registering that same symlinked directory as a knowledge source root
// slip past the identical confinement rule?
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { readApproved } from "../../../../src/vesper/tools/filesystem.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

const B = "/home/user/vesper-probes/filesystem-escape/sandbox";
const APPROVED = `${B}/approved`;

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
  config: { approvedRoots: [APPROVED], knowledgeSources: [] },
  providers: [
    scripted([
      { name: "knowledge_register", args: { id: "pwn", name: "pwn", root: `${APPROVED}/link-dir` } },
    ]),
  ],
});

console.log("approvedRoots =", JSON.stringify(runtime.config.approvedRoots));
console.log(
  "CONTROL fs_read <approved>/link-dir/flag.txt ->",
  JSON.stringify(await readApproved(runtime.config.approvedRoots, `${APPROVED}/link-dir/flag.txt`)),
);

let turn = await runtime.chat("index my notes");
const pending = turn.pendingConfirmations[0];
console.log("pending:", pending?.toolName, JSON.stringify(pending?.args));
turn = await runtime.chat("yes", { confirmId: pending!.id, approve: true });
for (const c of turn.toolCalls) {
  console.log("register ->", c.toolName, "ok=", c.result?.ok, c.result?.summary);
}

const count = await runtime.knowledge.reindex();
console.log("reindexed documents:", count);
console.log("SEARCH:", JSON.stringify(await runtime.knowledge.search("SECRET OUTSIDE ROOT", 5), null, 1));

await runtime.stop();
