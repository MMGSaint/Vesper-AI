/**
 * fs_write rollback — the pre-image, the reversal, and the refusals.
 *
 * The pattern the mission names is PLAN → AUTHORIZE → CAPTURE PRE-IMAGE → APPLY →
 * VERIFY → KEEP OR ROLLBACK. Authorization is already covered by the permission gate
 * and by filesystem-containment.test.ts; what is new here is that a write can be
 * undone, and — far more important — that it *refuses* to be undone in every case
 * where undoing it would destroy something.
 *
 * Every assertion below reads the FILESYSTEM or the checkpoint store, never the summary
 * string. A rollback that reported success and left the old bytes in place would pass a
 * message-based test, and that is precisely the failure the honesty rule forbids.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FS_WRITE_CHECKPOINT_TOOL,
  MAX_CHECKPOINT_PRE_IMAGE_BYTES,
  deleteApproved,
  readApprovedExact,
  writeApproved,
} from "./filesystem.ts";
import { CheckpointStore } from "../checkpoint.ts";
import { MemoryStorage } from "../storage.ts";
import type { Logger } from "../logging.ts";

const OUTSIDE_SECRET = "OUTSIDE-SECRET-MUST-SURVIVE";

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), "vesper-fsroll-"));
  const approved = join(base, "approved");
  const outside = join(base, "outside");
  await mkdir(approved, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "existing.txt"), OUTSIDE_SECRET, "utf8");
  return { base, approved, outside, roots: [approved] };
}

function silentLog(): Logger {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    audit: () => undefined,
    entries: () => [],
    child: () => log,
  };
  return log as unknown as Logger;
}

function newStore() {
  return new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The reverser the runtime registers, reproduced here against an explicit root list.
 *
 * A test that reimplemented the reversal loosely would prove nothing about the shipped
 * one, so this mirrors runtime.ts exactly: drift is "the file still holds what we
 * wrote", restore of an absent pre-image deletes, restore of a present one goes back
 * through `writeApproved` so every containment check runs again.
 */
function fsWriteReverser(rootsNow: () => string[]) {
  return {
    async verify(record: { after?: unknown; target: string }) {
      const after = typeof record.after === "string" ? record.after : null;
      if (after === null) return false;
      const current = await readApprovedExact(rootsNow(), record.target);
      return current.ok && current.present && current.content === after;
    },
    async restore(record: { absentBefore: boolean; before: unknown; target: string }) {
      if (record.absentBefore) {
        const removed = await deleteApproved(rootsNow(), record.target);
        if (!removed.ok) throw new Error(`Could not remove: ${removed.summary}`);
        return;
      }
      if (typeof record.before !== "string") {
        throw new Error("fs_write checkpoint `before` is not text; refusing to restore");
      }
      const restored = await writeApproved(rootsNow(), record.target, record.before);
      if (!restored.ok) throw new Error(`Could not restore: ${restored.summary}`);
    },
  };
}

describe("the pre-image records what was actually there", () => {
  it("records the previous contents of an existing file", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "notes.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const checkpointStore = newStore();

    const result = await writeApproved(roots, file, "REPLACED", false, { checkpointStore });

    assert.equal(result.ok, true);
    assert.equal(await readFile(file, "utf8"), "REPLACED", "the write must still happen");
    const [record] = await checkpointStore.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    assert.ok(record, "a checkpoint must be recorded");
    assert.equal(record.before, "ORIGINAL");
    assert.equal(record.absentBefore, false);
    assert.equal(record.after, "REPLACED", "the post-image must be recorded, or drift detection is a no-op");
  });

  it("distinguishes an ABSENT file from an EMPTY one", async () => {
    // These are different facts and the difference decides what a rollback does:
    // delete the file, or restore it empty. Collapsing them leaves a stray file behind
    // or removes one the user already had.
    const { approved, roots } = await sandbox();
    const store = newStore();

    await writeApproved(roots, join(approved, "fresh.txt"), "NEW", false, { checkpointStore: store });
    await writeFile(join(approved, "empty.txt"), "", "utf8");
    await writeApproved(roots, join(approved, "empty.txt"), "NEW", false, { checkpointStore: store });

    const records = await checkpointsByBasename(store);
    assert.equal(records["fresh.txt"]!.absentBefore, true, "a file that did not exist");
    assert.equal(records["fresh.txt"]!.before, null);
    assert.equal(records["empty.txt"]!.absentBefore, false, "a file that existed and was empty");
    assert.equal(records["empty.txt"]!.before, "", "an empty file's pre-image is the empty string, not null");
  });

  it("anchors the checkpoint on the RESOLVED path, not the string the caller passed", async () => {
    // A relative request binds to approvedRoots[0] during resolution. Storing the raw
    // argument would let a rollback restore a different file than the one written.
    const { approved, roots } = await sandbox();
    const store = newStore();

    await writeApproved(roots, "sub/deep.txt", "BODY", false, { checkpointStore: store });

    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    assert.ok(record!.target.startsWith(approved), `target must be absolute and inside the root: ${record!.target}`);
    assert.equal(await readFile(join(approved, "sub", "deep.txt"), "utf8"), "BODY");
  });

  it("records NO checkpoint when the write was refused", async () => {
    // A refused write changed nothing, so there is nothing to undo. A checkpoint here
    // would offer the user a rollback that reverses an action that never happened.
    const { approved, outside, roots } = await sandbox();
    await symlink(join(outside, "pwned.txt"), join(approved, "dangling"));
    const store = newStore();

    const result = await writeApproved(roots, join(approved, "dangling"), "MARK", false, {
      checkpointStore: store,
    });

    assert.equal(result.ok, false, "the write must still be refused");
    assert.equal(
      await exists(join(outside, "pwned.txt")),
      false,
      "containment must still hold with checkpointing enabled",
    );
    assert.deepEqual(await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL }), []);
  });

  it("records NO checkpoint for a path outside the approved roots", async () => {
    const { outside, roots } = await sandbox();
    const store = newStore();

    const result = await writeApproved(roots, join(outside, "existing.txt"), "MARK", false, {
      checkpointStore: store,
    });

    assert.equal(result.ok, false);
    assert.equal(await readFile(join(outside, "existing.txt"), "utf8"), OUTSIDE_SECRET);
    assert.deepEqual(await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL }), []);
  });

  it("writes without a checkpoint store exactly as it did before", async () => {
    // Every embedder that builds a runtime without one must keep working, and keep the
    // previous result shape.
    const { approved, roots } = await sandbox();
    const result = await writeApproved(roots, join(approved, "plain.txt"), "BODY");
    assert.equal(result.ok, true);
    assert.equal(result.data, undefined, "the no-checkpoint result shape must not change");
    assert.equal(await readFile(join(approved, "plain.txt"), "utf8"), "BODY");
  });
});

describe("a pre-image too large to hold is reported, never truncated", () => {
  it("writes the file but records no checkpoint, and says so", async () => {
    // Silently truncating the pre-image would be the worst outcome: rollback_apply
    // would report success while writing back a fragment of the user's file.
    const { approved, roots } = await sandbox();
    const file = join(approved, "big.txt");
    await writeFile(file, "x".repeat(MAX_CHECKPOINT_PRE_IMAGE_BYTES + 1), "utf8");
    const store = newStore();

    const result = await writeApproved(roots, file, "SMALL", false, { checkpointStore: store });

    assert.equal(result.ok, true, "the write itself still succeeds");
    assert.equal(await readFile(file, "utf8"), "SMALL");
    assert.deepEqual(await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL }), [], "no checkpoint may be recorded");
    assert.match(result.summary, /No undo was recorded/i, "the user must be told the write is not reversible");
    assert.equal((result.data as { checkpointed?: boolean }).checkpointed, false);
  });
});

describe("rollback restores what was there", () => {
  it("restores the previous contents of an overwritten file", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "notes.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "REPLACED", false, { checkpointStore: store });
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    const outcome = await store.rollback(record!.id);

    assert.equal(outcome.applied, true, `rollback refused: ${JSON.stringify(outcome)}`);
    assert.equal(await readFile(file, "utf8"), "ORIGINAL", "the file itself must hold the old bytes again");
  });

  it("DELETES a file the write created, rather than leaving it empty", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "created.txt");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "NEW", false, { checkpointStore: store });
    assert.equal(await exists(file), true, "precondition: the write created the file");
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    const outcome = await store.rollback(record!.id);

    assert.equal(outcome.applied, true, `rollback refused: ${JSON.stringify(outcome)}`);
    assert.equal(await exists(file), false, "the file Vesper created must be gone");
  });

  it("restores an empty file as empty, not as absent", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "wasEmpty.txt");
    await writeFile(file, "", "utf8");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "FILLED", false, { checkpointStore: store });
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    await store.rollback(record!.id);

    assert.equal(await exists(file), true, "the file must still exist");
    assert.equal(await readFile(file, "utf8"), "");
  });

  it("marks the checkpoint rolled back so it cannot be applied twice", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "twice.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "REPLACED", false, { checkpointStore: store });
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    await store.rollback(record!.id);
    const second = await store.rollback(record!.id);

    assert.equal(second.applied, false);
    assert.match(second.reason, /already been rolled back/i);
  });
});

describe("rollback refuses rather than destroying later work", () => {
  it("refuses when the file was modified after the write (drift)", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "drift.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "VESPER-WROTE-THIS", false, { checkpointStore: store });
    await writeFile(file, "USER-EDITED-THIS-AFTERWARDS", "utf8");
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    const outcome = await store.rollback(record!.id);

    assert.equal(outcome.applied, false, "a rollback must never overwrite a later edit");
    assert.match(outcome.reason, /drift/i);
    assert.equal(
      await readFile(file, "utf8"),
      "USER-EDITED-THIS-AFTERWARDS",
      "the user's later edit must survive untouched",
    );
  });

  it("refuses to DELETE a created file that the user has since edited", async () => {
    // The dangerous half of the absent-before case: rollback means delete, and deleting
    // a file the user has since made their own would destroy it outright.
    const { approved, roots } = await sandbox();
    const file = join(approved, "adopted.txt");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "VESPER-DRAFT", false, { checkpointStore: store });
    await writeFile(file, "USER-REWROTE-IT-ENTIRELY", "utf8");
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    const outcome = await store.rollback(record!.id);

    assert.equal(outcome.applied, false);
    assert.equal(await exists(file), true, "the user's file must not be deleted");
    assert.equal(await readFile(file, "utf8"), "USER-REWROTE-IT-ENTIRELY");
  });

  it("refuses when the file has been removed since the write", async () => {
    const { approved, roots } = await sandbox();
    const file = join(approved, "vanished.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    await writeApproved(roots, file, "REPLACED", false, { checkpointStore: store });
    await rm(file);
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
    const outcome = await store.rollback(record!.id);

    assert.equal(outcome.applied, false, "a missing file is unknown state, not 'no drift'");
    assert.equal(await exists(file), false, "and nothing is recreated behind the user's back");
  });

  it("refuses when no post-image was recorded", async () => {
    // A crash between snapshot and verify leaves the post-image absent. We do not know
    // what the file should look like, so we cannot tell a match from drift, and the
    // safe reading of "unknown" is REFUSE.
    const { approved, roots } = await sandbox();
    const file = join(approved, "unverified.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    const record = await store.snapshot({
      tool: FS_WRITE_CHECKPOINT_TOOL,
      target: file,
      before: "ORIGINAL",
      absentBefore: false,
    });
    const outcome = await store.rollback(record.id);

    assert.equal(outcome.applied, false);
    assert.equal(await readFile(file, "utf8"), "ORIGINAL");
  });
});

describe("rollback cannot cross the filesystem boundary", () => {
  it("refuses to restore a checkpoint whose target has left the approved roots", async () => {
    // The persisted checkpoint blob is attacker-influenceable and the approved roots can
    // narrow between the write and the undo. Re-running containment at restore time is
    // what stops the rollback path becoming an arbitrary-file-write primitive that
    // bypasses the boundary fs_write itself respects.
    const { approved, roots } = await sandbox();
    const file = join(approved, "orphaned.txt");
    await writeFile(file, "ORIGINAL", "utf8");
    const store = newStore();
    let currentRoots = roots;
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => currentRoots));

    await writeApproved(roots, file, "REPLACED", false, { checkpointStore: store });
    const [record] = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });

    // The user removes this root from their configuration.
    currentRoots = [];
    const outcome = await store.rollback(record!.id);

    assert.equal(outcome.applied, false, "a rollback must not reach outside the CURRENT roots");
    assert.equal(await readFile(file, "utf8"), "REPLACED", "and must not touch the file");
  });

  it("refuses a planted checkpoint that targets a file outside every root", async () => {
    const { outside, roots } = await sandbox();
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    // As a corrupted `rollback.checkpoints` blob would look after being tampered with.
    const record = await store.snapshot({
      tool: FS_WRITE_CHECKPOINT_TOOL,
      target: join(outside, "existing.txt"),
      before: "ATTACKER-CONTROLLED",
      absentBefore: false,
    });
    await store.verify(record.id, OUTSIDE_SECRET);
    const outcome = await store.rollback(record.id);

    assert.equal(outcome.applied, false);
    assert.equal(
      await readFile(join(outside, "existing.txt"), "utf8"),
      OUTSIDE_SECRET,
      "the file outside the root must be untouched",
    );
  });

  it("refuses a planted checkpoint whose deletion target is outside every root", async () => {
    const { outside, roots } = await sandbox();
    const store = newStore();
    store.registerReverser(FS_WRITE_CHECKPOINT_TOOL, fsWriteReverser(() => roots));

    const record = await store.snapshot({
      tool: FS_WRITE_CHECKPOINT_TOOL,
      target: join(outside, "existing.txt"),
      before: null,
      absentBefore: true,
    });
    await store.verify(record.id, OUTSIDE_SECRET);
    const outcome = await store.rollback(record.id);

    assert.equal(outcome.applied, false, "rollback-as-delete must not reach outside the roots either");
    assert.equal(await exists(join(outside, "existing.txt")), true, "the outside file must still exist");
  });
});

describe("the contained delete primitive holds the same boundary as the write", () => {
  it("refuses a path outside the approved roots", async () => {
    const { outside, roots } = await sandbox();
    const result = await deleteApproved(roots, join(outside, "existing.txt"));
    assert.equal(result.ok, false);
    assert.equal(await exists(join(outside, "existing.txt")), true);
  });

  it("refuses to remove a symlink rather than following it", async () => {
    const { approved, outside, roots } = await sandbox();
    await symlink(join(outside, "existing.txt"), join(approved, "link"));

    const result = await deleteApproved(roots, join(approved, "link"));

    assert.equal(result.ok, false);
    assert.equal(
      await exists(join(outside, "existing.txt")),
      true,
      "the link's target outside the root must survive",
    );
  });

  it("refuses to remove a directory", async () => {
    const { approved, roots } = await sandbox();
    await mkdir(join(approved, "adir"));
    const result = await deleteApproved(roots, join(approved, "adir"));
    assert.equal(result.ok, false);
    assert.equal(await exists(join(approved, "adir")), true);
  });

  it("removes a plain file inside the root", async () => {
    const { approved, roots } = await sandbox();
    await writeFile(join(approved, "gone.txt"), "x", "utf8");
    const result = await deleteApproved(roots, join(approved, "gone.txt"));
    assert.equal(result.ok, true);
    assert.equal(await exists(join(approved, "gone.txt")), false);
  });
});

describe("a refused write no longer destroys the file first", () => {
  it("leaves a hard-linked file's contents intact when it refuses", async () => {
    // The open used to carry O_TRUNC, so by the time the hard-link check ran the file
    // was already empty: an ok:false that had destroyed the user's data. The refusal is
    // the same; what changed is that it is now true.
    const { approved, outside, roots } = await sandbox();
    const target = join(approved, "linked.txt");
    await writeFile(target, "IMPORTANT-CONTENT", "utf8");
    await link(target, join(outside, "other-name.txt"));

    const result = await writeApproved(roots, target, "REPLACED");

    assert.equal(result.ok, false, "a multiply-linked file must still be refused");
    assert.match(result.summary, /hard link/i);
    assert.equal(
      await readFile(target, "utf8"),
      "IMPORTANT-CONTENT",
      "refusing must not have emptied the file",
    );
  });
});

/** Index the store's fs_write checkpoints by the basename of their target. */
async function checkpointsByBasename(store: CheckpointStore) {
  const records = await store.list({ tool: FS_WRITE_CHECKPOINT_TOOL });
  const out: Record<string, (typeof records)[number]> = {};
  for (const record of records) out[record.target.split(/[\\/]/).pop()!] = record;
  return out;
}
