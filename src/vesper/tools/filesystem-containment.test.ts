import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApproved, readApproved, writeApproved } from "./filesystem.ts";
import { testRuntime } from "../test-helpers.ts";
import type { CompletionRequest, ModelToolCall } from "../types.ts";

/**
 * Containment means the bytes stay under an approved root. Resolving a path and then
 * opening it are two acts, and everything dangerous lives in the gap between them.
 *
 * The defect these tests exist for: `realpath` reports a *dangling* symlink as "does not
 * exist yet", so containment concluded the path was inside the root while the write
 * followed the link straight out of it. Reproduced end-to-end, writing into /etc.
 *
 * Every assertion here checks the **filesystem**, not the return value — a refusal that
 * still wrote the file would pass a summary-based test.
 */

const MARK = "ESCAPED-THE-APPROVED-ROOT";
const OUTSIDE_SECRET = "OUTSIDE-SECRET";

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), "vesper-contain-"));
  const approved = join(base, "approved");
  const outside = join(base, "outside");
  await mkdir(approved, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "existing.txt"), OUTSIDE_SECRET, "utf8");
  return { base, approved, outside, roots: [approved] };
}

async function contains(path: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).includes(needle);
  } catch {
    return false;
  }
}

describe("a write never escapes the approved root through a link", () => {
  it("refuses a dangling symlink and leaves nothing outside the root", async () => {
    // The original CRITICAL. realpath cannot resolve a link whose target does not exist,
    // so the check passed and writeFile followed the link out.
    const { approved, outside, roots } = await sandbox();
    await symlink(join(outside, "pwned.txt"), join(approved, "dangling"));

    const result = await writeApproved(roots, join(approved, "dangling"), MARK);

    assert.equal(
      await contains(join(outside, "pwned.txt"), MARK),
      false,
      "the write escaped the approved root",
    );
    assert.equal(result.ok, false);
  });

  it("refuses a dangling symlink with a relative target", async () => {
    const { approved, outside, roots } = await sandbox();
    await symlink("../outside/rel.txt", join(approved, "rel"));
    await writeApproved(roots, join(approved, "rel"), MARK);
    assert.equal(await contains(join(outside, "rel.txt"), MARK), false);
  });

  it("refuses a chain of symlinks ending outside", async () => {
    const { approved, outside, roots } = await sandbox();
    await symlink(join(outside, "chain.txt"), join(approved, "b"));
    await symlink(join(approved, "b"), join(approved, "a"));
    await writeApproved(roots, join(approved, "a"), MARK);
    assert.equal(await contains(join(outside, "chain.txt"), MARK), false);
  });

  it("refuses a write whose parent directory is a symlink out of the root", async () => {
    // O_NOFOLLOW only guards the final component; a symlinked parent needs its own check.
    const { approved, outside, roots } = await sandbox();
    await symlink(outside, join(approved, "linkdir"));
    await writeApproved(roots, join(approved, "linkdir", "viaparent.txt"), MARK);
    assert.equal(await contains(join(outside, "viaparent.txt"), MARK), false);
  });

  it("refuses a write whose parent is a dangling symlinked directory", async () => {
    // mkdir -p will resolve through a link, so the parent is re-checked after creation.
    const { approved, outside, roots } = await sandbox();
    await symlink(join(outside, "newdir"), join(approved, "danglingdir"));
    await writeApproved(roots, join(approved, "danglingdir", "x.txt"), MARK);
    assert.equal(await contains(join(outside, "newdir", "x.txt"), MARK), false);
  });

  it("refuses a dangling symlink nested below the root", async () => {
    const { approved, outside, roots } = await sandbox();
    await mkdir(join(approved, "a", "b"), { recursive: true });
    await symlink(join(outside, "nested.txt"), join(approved, "a", "b", "n"));
    await writeApproved(roots, join(approved, "a", "b", "n"), MARK);
    assert.equal(await contains(join(outside, "nested.txt"), MARK), false);
  });

  it("refuses to write through a hard link, whose other name may be outside", async () => {
    // A hard link is not a reference to a file, it *is* the file under another name, so
    // path resolution can never reveal that one of its names is outside the root.
    const { approved, outside, roots } = await sandbox();
    await link(join(outside, "existing.txt"), join(approved, "hardlink.txt"));
    await writeApproved(roots, join(approved, "hardlink.txt"), MARK);
    assert.equal(
      await contains(join(outside, "existing.txt"), MARK),
      false,
      "the write reached the outside file through a hard link",
    );
  });

  it("escapes nothing end-to-end through the runtime's fs_write tool", async () => {
    // The unit helpers are not the product. This drives a real turn with a model that
    // does what an attacker would want.
    const { approved, outside } = await sandbox();
    await symlink(join(outside, "runtime.txt"), join(approved, "d2"));
    let n = 0;
    const provider = {
      id: "atk",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "atk" };
      },
      async complete(request: CompletionRequest, model: string) {
        n += 1;
        const toolCalls: ModelToolCall[] =
          n === 1
            ? [{ id: "c1", name: "fs_write", arguments: { path: join(approved, "d2"), content: MARK } as never }]
            : [];
        return { text: n === 1 ? "" : "done", toolCalls, providerId: "atk", model, role: request.role };
      },
    };
    const runtime = await testRuntime({ providers: [provider], config: { approvedRoots: [approved] } });
    await runtime.chat("tidy my notes");
    const id = [...runtime.confirmations.keys()][0];
    if (id) await runtime.chat("yes", { confirmId: id, approve: true });

    assert.equal(
      await contains(join(outside, "runtime.txt"), MARK),
      false,
      "fs_write escaped the approved root through the runtime",
    );
    await runtime.stop();
  });
});

describe("a read never escapes the approved root through a link", () => {
  it("refuses an existing symlink pointing outside", async () => {
    const { approved, outside, roots } = await sandbox();
    await symlink(join(outside, "existing.txt"), join(approved, "peek"));
    const result = await readApproved(roots, join(approved, "peek"));
    assert.equal(JSON.stringify(result).includes(OUTSIDE_SECRET), false);
  });

  it("refuses a read through a symlinked parent directory", async () => {
    const { approved, outside, roots } = await sandbox();
    await symlink(outside, join(approved, "linkdir"));
    const result = await readApproved(roots, join(approved, "linkdir", "existing.txt"));
    assert.equal(JSON.stringify(result).includes(OUTSIDE_SECRET), false);
  });
});

describe("containment narrows without severing", () => {
  it("still writes a plain file, including into a directory it must create", async () => {
    const { approved, roots } = await sandbox();
    const plain = await writeApproved(roots, join(approved, "notes.txt"), "hello");
    assert.equal(plain.ok, true, plain.summary);
    assert.equal(await contains(join(approved, "notes.txt"), "hello"), true);

    const nested = await writeApproved(roots, join(approved, "deep", "nested", "notes.txt"), "hello");
    assert.equal(nested.ok, true, nested.summary);
    assert.equal(await contains(join(approved, "deep", "nested", "notes.txt"), "hello"), true);
  });

  it("still reads through a symlink that stays inside the root", async () => {
    // Legitimate symlinks are resolved away before the open, so refusing to *follow* one
    // at the final component costs nothing here.
    const { approved, roots } = await sandbox();
    await writeFile(join(approved, "real.txt"), "IN-ROOT-CONTENT", "utf8");
    await symlink(join(approved, "real.txt"), join(approved, "alias"));
    const result = await readApproved(roots, join(approved, "alias"));
    assert.equal(result.ok, true, result.summary);
    assert.equal(JSON.stringify(result).includes("IN-ROOT-CONTENT"), true);
  });

  it("still lists an approved directory", async () => {
    const { approved, roots } = await sandbox();
    await writeFile(join(approved, "a.txt"), "a", "utf8");
    const result = await listApproved(roots, approved);
    assert.equal(result.ok, true, result.summary);
  });

  it("overwrites an ordinary single-linked file", async () => {
    // The hard-link refusal must not catch normal files.
    const { approved, roots } = await sandbox();
    await writeFile(join(approved, "once.txt"), "first", "utf8");
    assert.equal((await stat(join(approved, "once.txt"))).nlink, 1);
    const result = await writeApproved(roots, join(approved, "once.txt"), "second");
    assert.equal(result.ok, true, result.summary);
    assert.equal(await contains(join(approved, "once.txt"), "second"), true);
  });
});

describe("a knowledge source cannot index outside the approved roots", () => {
  it("refuses a symlinked directory as a source root", async () => {
    // The containment check compared lexical paths, so a link sitting inside the
    // approved root read as satisfied while the indexer read everything it pointed at.
    const { approved, outside, base } = await sandbox();
    await writeFile(join(outside, "secret.md"), "KNOWLEDGE-SECRET", "utf8");
    await symlink(outside, join(approved, "link-dir"));

    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });
    const registered = runtime.knowledge.registerSource({
      id: "pwn",
      name: "pwn",
      roots: [join(approved, "link-dir")],
      enabled: true,
    });
    assert.equal(registered.ok, false, "a symlinked root was registered");

    await runtime.knowledge.reindex();
    const hits = await runtime.knowledge.searchAsync("KNOWLEDGE-SECRET", { limit: 5 });
    assert.equal(
      JSON.stringify(hits).includes("KNOWLEDGE-SECRET"),
      false,
      "the index exposed a file outside the approved roots",
    );
    await runtime.stop();
    assert.ok(base.length > 0);
  });

  it("skips a root that becomes a symlink after it was registered", async () => {
    // Registration and indexing are separated by time, so a root approved as a real
    // directory can be a link by the time it is read. This is caught by the walker's own
    // per-entry containment rather than by the registration fix — asserted here because
    // it is a property worth holding, not because this change introduced it.
    const { approved, outside } = await sandbox();
    await writeFile(join(outside, "secret.md"), "KNOWLEDGE-SECRET", "utf8");
    const realDir = join(approved, "docs");
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, "ok.md"), "ordinary notes", "utf8");

    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });
    const registered = runtime.knowledge.registerSource({
      id: "docs",
      name: "docs",
      roots: [realDir],
      enabled: true,
    });
    assert.equal(registered.ok, true, registered.summary);

    // The directory is swapped for a link to somewhere else entirely.
    await rm(realDir, { recursive: true, force: true });
    await symlink(outside, realDir);

    await runtime.knowledge.reindex();
    const hits = await runtime.knowledge.searchAsync("KNOWLEDGE-SECRET", { limit: 5 });
    assert.equal(
      JSON.stringify(hits).includes("KNOWLEDGE-SECRET"),
      false,
      "a root swapped for a symlink after registration was still indexed",
    );
    await runtime.stop();
  });

  it("still registers and indexes an ordinary directory", async () => {
    const { approved } = await sandbox();
    const docs = join(approved, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "notes.md"), "capture card settings for streaming", "utf8");

    const runtime = await testRuntime({ config: { approvedRoots: [approved] } });
    const registered = runtime.knowledge.registerSource({
      id: "docs",
      name: "docs",
      roots: [docs],
      enabled: true,
    });
    assert.equal(registered.ok, true, registered.summary);
    await runtime.knowledge.reindex();
    const hits = await runtime.knowledge.searchAsync("capture card settings", { limit: 5 });
    assert.ok(hits.length > 0, "an ordinary knowledge root stopped being indexed");
    await runtime.stop();
  });
});

describe("the platform without O_NOFOLLOW catches a swap it could not prevent", () => {
  /**
   * Windows has no `O_NOFOLLOW` and Node exposes no equivalent, so the symlink check
   * cannot be part of the `open` and has to be made around it. CodeQL's
   * `js/file-system-race` flags exactly that, and on Windows it is right: the sequence is
   * not atomic and cannot be made atomic here.
   *
   * What *can* be done is inspect the handle rather than the path afterwards. If the path
   * was swapped for a link between the check and the open, `open` followed it and the
   * handle refers to the link's target — whose identity differs from what the path names.
   * That is the part which does not race, and swapping back afterwards does not help.
   *
   * This test forces that branch on Linux and performs the swap by hand, because the
   * branch is unreachable on the platform the suite runs on and the race is unreachable
   * on the platform where the branch is live. It proves the *mechanism*, not the Windows
   * behaviour — see security/BACKLOG.md §1.1 for what remains unproven there.
   */
  it("refuses when the opened handle is not the file the path named", async () => {
    const { openContainedForTest } = await import("./filesystem.ts");
    const { approved, outside } = await sandbox();
    const target = join(approved, "raced.txt");
    await writeFile(target, "the real file", "utf8");
    await writeFile(join(outside, "attacker.txt"), OUTSIDE_SECRET, "utf8");

    // The swap happens between the pre-check and the open, which is exactly the window.
    const result = await openContainedForTest(target, 0, async () => {
      await rm(target);
      await symlink(join(outside, "attacker.txt"), target);
    });
    assert.equal(result.ok, false, "a raced swap was not detected");
    if (!result.ok) assert.match(result.summary, /symbolic link/i);
  });

  it("refuses even when the attacker puts the real file back afterwards", async () => {
    // The case a second look at the *path* cannot catch, and the reason the check
    // inspects the handle: by the time anything re-reads the path it names the honest
    // file again, while the handle still refers to what the link pointed at.
    const { openContainedForTest } = await import("./filesystem.ts");
    const { approved, outside } = await sandbox();
    const target = join(approved, "raced-back.txt");
    await writeFile(target, "the real file", "utf8");
    await writeFile(join(outside, "attacker.txt"), OUTSIDE_SECRET, "utf8");

    const result = await openContainedForTest(
      target,
      0,
      async () => {
        await rm(target);
        await symlink(join(outside, "attacker.txt"), target);
      },
      async () => {
        await rm(target);
        await writeFile(target, "the real file", "utf8");
      },
    );
    assert.equal(result.ok, false, "a swap-and-swap-back went undetected");
  });

  it("still opens an ordinary file when nothing races it", async () => {
    // Narrowing, not severing: the identity comparison must not reject honest opens.
    const { openContainedForTest } = await import("./filesystem.ts");
    const { approved } = await sandbox();
    const target = join(approved, "quiet.txt");
    await writeFile(target, "nothing happened here", "utf8");
    const result = await openContainedForTest(target, 0);
    assert.equal(result.ok, true, "an unraced open was refused");
    if (result.ok) await result.handle.close();
  });
});
