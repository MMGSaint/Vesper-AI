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

  it("dry-runs fs_write when queueing confirmation, without writing the file", async () => {
    const approved = join(tmpdir(), `vesper-dryrun-${Date.now()}`);
    await mkdir(approved, { recursive: true });
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });
    const content = "DRY_RUN_BODY_MUST_NOT_LAND";
    const queued = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: "dry-run.md", content },
      workspaceId: "general",
    });
    assert.equal(queued.decision.requiresConfirmation, true);
    assert.ok(queued.confirmationId);
    const pending = runtime.confirmations.get(queued.confirmationId!);
    assert.ok(pending?.preview);
    assert.equal(pending?.preview?.executed, false);
    assert.equal(pending?.preview?.dryRunAttempted, true);
    assert.match(pending?.preview?.wouldHappen ?? "", /Would create/);
    assert.equal(pending?.preview?.wouldHappen?.includes(content), false);

    const listed = await runtime.tools.invoke({
      name: "fs_list",
      args: { path: "." },
      workspaceId: "general",
    });
    assert.equal(
      JSON.stringify(listed.result?.data ?? {}).includes("dry-run.md"),
      false,
      "queueing a confirmation must not create the file",
    );

    const approvedWrite = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: "dry-run.md", content },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(approvedWrite.result?.ok, true, approvedWrite.result?.summary);
    const read = await runtime.tools.invoke({
      name: "fs_read",
      args: { path: "dry-run.md" },
      workspaceId: "general",
    });
    assert.equal(read.result?.ok, true);
    const text = (read.result?.data as { text?: string } | undefined)?.text ?? "";
    assert.equal(text, content);
  });
});
