import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApproved, readApproved, resolveApprovedPath, writeApproved } from "./filesystem.ts";
import { testRuntime } from "../test-helpers.ts";

describe("confined filesystem tools", () => {
  it("rejects traversal and dangerous roots", () => {
    const denied = resolveApprovedPath(["docs"], "../secret");
    assert.equal(denied.ok, false);
    const unix = resolveApprovedPath(["docs"], "/etc/passwd");
    assert.equal(unix.ok, false);
  });

  it("lists and reads inside an approved directory", async () => {
    const root = join(tmpdir(), `vesper-fs-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "note.txt"), "hello from approved root", "utf8");
    const listed = await listApproved([root], root);
    assert.equal(listed.ok, true);
    const read = await readApproved([root], "note.txt");
    assert.equal(read.ok, true);
    assert.match(read.summary, /note.txt/);
  });

  it("queues confirmation before writing", async () => {
    const runtime = await testRuntime();
    const pending = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: "docs/tmp.md", content: "nope" },
      workspaceId: "general",
    });
    assert.equal(pending.decision.requiresConfirmation, true);
  });
});
