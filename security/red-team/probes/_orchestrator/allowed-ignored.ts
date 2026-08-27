import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";

const base = await mkdtemp(join(tmpdir(), "vesper-ai-bypass-"));
const approved = join(base, "notes");
await mkdir(approved, { recursive: true });

// Can a corrupt/hostile permission OVERRIDE turn a confirm-tier tool autonomous?
// If an unrecognised level is neither "never" nor "confirm", the confirmation branch is
// skipped and nothing else consults decision.allowed.
for (const override of ["archmage", "", "ALLOW", "read ", null, 1, true, [], {}]) {
  const runtime = await testRuntime({
    config: {
      approvedRoots: [approved],
      permissions: { toolOverrides: { fs_write: override } } as never,
    },
  });
  const target = join(approved, `probe-${String(override).replace(/\W+/g, "_")}.txt`);
  const record = await runtime.tools.invoke({
    name: "fs_write",
    args: { path: target, content: "WRITTEN-WITHOUT-CONFIRMATION" },
    workspaceId: "general",
  });
  let onDisk = false;
  try {
    onDisk = (await readFile(target, "utf8")).includes("WRITTEN-WITHOUT-CONFIRMATION");
  } catch {
    onDisk = false;
  }
  console.log(
    `override=${JSON.stringify(override).padEnd(12)} level=${String(record.decision.level).padEnd(10)}` +
      ` allowed=${String(record.decision.allowed).padEnd(5)} confirm=${String(record.decision.requiresConfirmation).padEnd(5)}` +
      ` wroteFile=${onDisk ? "*** YES" : "no"}`,
  );
  await runtime.stop();
}
