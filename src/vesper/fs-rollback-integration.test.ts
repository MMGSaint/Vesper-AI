/**
 * fs_write rollback, through the real runtime.
 *
 * filesystem-rollback.test.ts covers the mechanism against an explicitly constructed
 * reverser. That proves the design and proves nothing about the product: a reverser the
 * runtime never registers is "implemented and tested, not wired", and the tool result
 * would advertise a `checkpointId` that `rollback_apply` then refuses with "no reverser
 * registered" — a claim of reversibility Vesper could not honour.
 *
 * So these go through `createRuntime`, the registered tool, and the reverser the runtime
 * actually installs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "./test-helpers.ts";

async function approvedSandbox() {
  const base = await mkdtemp(join(tmpdir(), "vesper-fsint-"));
  const approved = join(base, "docs");
  await mkdir(approved, { recursive: true });
  return { base, approved };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("fs_write rollback is wired into the real runtime", () => {
  it("a write through the tool records a reversible checkpoint, and the runtime can reverse it", async () => {
    const { approved } = await approvedSandbox();
    const file = join(approved, "notes.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const call = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: file, content: "REPLACED" },
      workspaceId: "general",
      confirmed: true,
    });

    assert.equal(call.result?.ok, true, `write refused: ${call.result?.summary}`);
    assert.equal(await readFile(file, "utf8"), "REPLACED");

    const checkpointId = (call.result?.data as { checkpointId?: string } | undefined)?.checkpointId;
    assert.ok(checkpointId, "the tool result must carry the checkpoint id, or nothing can aim a rollback at it");

    // The reverser under test is the one runtime.ts registers — not a local stand-in.
    const outcome = await runtime.checkpoints.rollback(checkpointId);
    assert.equal(
      outcome.applied,
      true,
      `rollback refused: ${outcome.applied ? "" : outcome.reason}`,
    );
    assert.equal(await readFile(file, "utf8"), "ORIGINAL", "the file must hold the previous bytes again");
  });

  it("rolling back a file the runtime created deletes it", async () => {
    const { approved } = await approvedSandbox();
    const file = join(approved, "created.txt");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const call = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: file, content: "DRAFT" },
      workspaceId: "general",
      confirmed: true,
    });
    const checkpointId = (call.result?.data as { checkpointId?: string }).checkpointId!;
    assert.equal(await exists(file), true);

    const outcome = await runtime.checkpoints.rollback(checkpointId);

    assert.equal(outcome.applied, true, `rollback refused: ${outcome.applied ? "" : outcome.reason}`);
    assert.equal(await exists(file), false);
  });

  it("the rollback_apply tool reverses a file write end to end", async () => {
    // rollback_apply dispatches purely on the record's `tool` string, so this is the
    // check that the registered name and the snapshotted name are the same string.
    const { approved } = await approvedSandbox();
    const file = join(approved, "viatool.txt");
    await writeFile(file, "BEFORE", "utf8");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const write = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: file, content: "AFTER" },
      workspaceId: "general",
      confirmed: true,
    });
    const checkpointId = (write.result?.data as { checkpointId?: string }).checkpointId!;

    const undo = await runtime.tools.invoke({
      name: "rollback_apply",
      args: { id: checkpointId },
      workspaceId: "general",
      confirmed: true,
    });

    assert.equal(undo.result?.ok, true, `rollback_apply failed: ${undo.result?.summary}`);
    assert.equal(await readFile(file, "utf8"), "BEFORE");
  });

  it("rollback_list shows a file write as reversible", async () => {
    const { approved } = await approvedSandbox();
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });
    await runtime.tools.invoke({
      name: "fs_write",
      args: { path: join(approved, "listed.txt"), content: "X" },
      workspaceId: "general",
      confirmed: true,
    });

    const listed = await runtime.tools.invoke({
      name: "rollback_list",
      args: {},
      workspaceId: "general",
    });

    assert.equal(listed.result?.ok, true);
    assert.match(JSON.stringify(listed.result?.data), /fs_write/);
  });

  it("refuses to reverse a write the user has since edited", async () => {
    const { approved } = await approvedSandbox();
    const file = join(approved, "edited.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const call = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: file, content: "VESPER" },
      workspaceId: "general",
      confirmed: true,
    });
    const checkpointId = (call.result?.data as { checkpointId?: string }).checkpointId!;
    await writeFile(file, "USER-EDIT", "utf8");

    const outcome = await runtime.checkpoints.rollback(checkpointId);

    assert.equal(outcome.applied, false);
    assert.equal(await readFile(file, "utf8"), "USER-EDIT", "the user's edit must survive");
  });

  it("a write refused by containment leaves no checkpoint behind", async () => {
    const { base, approved } = await approvedSandbox();
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const call = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: join(base, "outside.txt"), content: "ESCAPED" },
      workspaceId: "general",
      confirmed: true,
    });

    assert.equal(call.result?.ok, false, "the write must be refused");
    assert.equal(await exists(join(base, "outside.txt")), false);
    const cps = await runtime.checkpoints.list({ tool: "fs_write" });
    assert.deepEqual(cps, [], "a refused write changed nothing, so there is nothing to undo");
  });

  it("refuses a checkpoint whose target lies outside the approved roots", async () => {
    // The threat this defends: `rollback.checkpoints` is persisted in the shared state
    // file, so its contents are attacker-influenceable. If restore() trusted the
    // recorded target, the rollback path would be an arbitrary-file-write primitive
    // that bypasses the very boundary fs_write respects — reachable by editing a JSON
    // file rather than by calling a tool.
    const { base, approved } = await approvedSandbox();
    const outside = join(base, "outside.txt");
    await writeFile(outside, "OUTSIDE-SECRET", "utf8");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const planted = await runtime.checkpoints.snapshot({
      tool: "fs_write",
      target: outside,
      before: "ATTACKER-CONTROLLED",
      absentBefore: false,
    });
    await runtime.checkpoints.verify(planted.id, "OUTSIDE-SECRET");

    const outcome = await runtime.checkpoints.rollback(planted.id);

    assert.equal(outcome.applied, false, "the rollback must be refused");
    assert.equal(
      await readFile(outside, "utf8"),
      "OUTSIDE-SECRET",
      "the file outside the approved root must be untouched",
    );
  });

  it("refuses a checkpoint that would DELETE a file outside the approved roots", async () => {
    // The same tampering aimed at the absent-before branch, where restoring means
    // removing. A refusal that only covered the write branch would leave a
    // delete-anything primitive behind.
    const { base, approved } = await approvedSandbox();
    const outside = join(base, "victim.txt");
    await writeFile(outside, "DO-NOT-DELETE", "utf8");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const planted = await runtime.checkpoints.snapshot({
      tool: "fs_write",
      target: outside,
      before: null,
      absentBefore: true,
    });
    await runtime.checkpoints.verify(planted.id, "DO-NOT-DELETE");

    const outcome = await runtime.checkpoints.rollback(planted.id);

    assert.equal(outcome.applied, false);
    assert.equal(await exists(outside), true, "the file outside the root must still exist");
  });

  it("fs_write is still confirm-tier: an unconfirmed call writes nothing", async () => {
    // Rollback must not have quietly turned a confirm-tier tool into an autonomous one.
    const { approved } = await approvedSandbox();
    const file = join(approved, "unconfirmed.txt");
    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

    const call = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: file, content: "SHOULD-NOT-EXIST" },
      workspaceId: "general",
    });

    assert.ok(call.confirmationId, "the call must be held for confirmation");
    assert.equal(call.result, undefined, "and must not have run");
    assert.equal(await exists(file), false);
  });
});
