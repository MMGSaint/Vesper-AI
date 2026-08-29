import { readdir, mkdir, open, lstat, unlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  assertWithinRoot,
  containsTraversal,
  isDangerousRoot,
  isVesperOwnPath,
  resolveRealWithinRoot,
} from "../security.ts";
import type { JsonObject, ToolExecutionResult } from "../types.ts";
import type { CheckpointStore } from "../checkpoint.ts";

/**
 * The `tool` string a checkpoint for a file write is filed under.
 *
 * Shared by the snapshot call site here and the reverser registration in runtime.ts.
 * `CheckpointStore` keys reversers by a free-form string with no type to catch a typo,
 * and a mismatch does not fail loudly: the checkpoint records fine and only refuses at
 * the moment a user tries to undo, with "no reverser registered". One constant, two
 * call sites.
 */
export const FS_WRITE_CHECKPOINT_TOOL = "fs_write";

/**
 * Largest pre-image, in BYTES, that is worth copying into the checkpoint blob.
 *
 * Every checkpoint lives in one JSON array under a single storage key, and the whole
 * array is re-serialised on every snapshot (checkpoint.ts). `writeApproved` caps content
 * at 256_000 *characters*, which is up to about 1 MB of UTF-8, and the store retains 100
 * records — so snapshotting file contents naively would rewrite tens of megabytes on
 * every unrelated checkpoint.
 *
 * Above this size Vesper records NO checkpoint and says so in the result. That is the
 * honest failure: advertising a checkpointId whose pre-image was silently truncated
 * would make `rollback_apply` corrupt the file it claims to restore.
 */
export const MAX_CHECKPOINT_PRE_IMAGE_BYTES = 64 * 1024;

export function resolveApprovedPath(
  approvedRoots: string[],
  requested: string,
): { ok: true; path: string; root: string } | { ok: false; summary: string } {
  if (!requested || containsTraversal(requested) || requested.includes("\0")) {
    return { ok: false, summary: "Path traversal is not allowed." };
  }
  if (isDangerousRoot(requested)) {
    return { ok: false, summary: "Refused a dangerous filesystem root." };
  }
  // Vesper's own data and configuration are not documents. They hold the device private
  // key, the audit trail, the device registry and the memory store, and an approved root
  // that happens to contain them must not turn any of that into a readable file.
  if (isVesperOwnPath(requested)) {
    return { ok: false, summary: "Refused to touch Vesper's own data or configuration." };
  }
  if (!approvedRoots.length) {
    return { ok: false, summary: "No approved filesystem roots are configured." };
  }
  for (const root of approvedRoots) {
    try {
      const resolved = requested.startsWith(root) || requested === root
        ? assertWithinRoot(root, requested === root ? "." : relative(root, requested) || ".")
        : assertWithinRoot(root, requested);
      return { ok: true, path: resolved, root };
    } catch {
      // try next root
    }
  }
  return { ok: false, summary: "Path is outside approved roots." };
}

/**
 * Resolve a requested path and confirm it stays inside an approved root *after*
 * symlinks are followed. The lexical check alone is defeated by a link planted inside
 * an approved directory.
 */
export async function resolveApprovedPathReal(
  approvedRoots: string[],
  requested: string,
): Promise<{ ok: true; path: string; root: string } | { ok: false; summary: string }> {
  const lexical = resolveApprovedPath(approvedRoots, requested);
  if (lexical.ok) {
    const real = await resolveRealWithinRoot(lexical.root, lexical.path);
    if (!real.ok) return { ok: false, summary: real.reason };
    return { ok: true, path: real.path, root: real.root };
  }

  // Second pass against the roots as the filesystem actually names them.
  //
  // The defect this fixes, reproduced before it was written: an approved root that is
  // itself a symlink — or a macOS /var, or a Windows TEMP in 8.3 short form — makes
  // every fs_write rollback refuse. The write resolves and records the checkpoint under
  // the REAL path, as it must, so that a rollback restores the file that was written.
  // Re-checking that real path later then fails the LEXICAL comparison above, because it
  // is compared against the root as the user spelled it. `resolveRealWithinRoot` handles
  // this case correctly and never gets the chance: the lexical pass refuses first.
  //
  // The user sees a rollback that refuses with "the state has drifted", which is
  // indistinguishable from the drift protection working.
  //
  // This is NOT a widening of containment, and the distinction matters:
  //   - `realpath(R)` and `R` are the same directory, so a path under one is inside the
  //     other. No file becomes reachable that was not reachable before — only an
  //     additional NAME for a file the user already approved.
  //   - Every refusal in `resolveApprovedPath` that is about the REQUEST rather than the
  //     root — traversal, null bytes, dangerous roots, Vesper's own paths — runs again
  //     unchanged in this pass.
  //   - `resolveRealWithinRoot` still performs the authoritative post-symlink check.
  // Mutation-checked against the containment suite: the escape tests still fail if the
  // real check is removed.
  const canonical = await canonicalRoots(approvedRoots);
  if (canonical.length === 0) return lexical;
  const second = resolveApprovedPath(canonical, requested);
  // Keep the FIRST refusal. It names the root the user configured, which is the one they
  // can act on; a message about a path they never typed would be a worse answer.
  if (!second.ok) return lexical;
  const real = await resolveRealWithinRoot(second.root, second.path);
  if (!real.ok) return { ok: false, summary: real.reason };
  return { ok: true, path: real.path, root: real.root };
}

/**
 * The approved roots as the filesystem names them, keeping only those that differ.
 *
 * An empty result means canonicalisation changed nothing and the second pass would
 * repeat the first exactly.
 */
async function canonicalRoots(approvedRoots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of approvedRoots) {
    try {
      const real = await realpath(root);
      if (real !== root) out.push(real);
    } catch {
      // A root that does not exist cannot be canonicalised. Nothing to add; the first
      // pass's refusal stands.
    }
  }
  return out;
}

/**
 * Open a path that containment has already approved, refusing to traverse a symlink at
 * the final component.
 *
 * Resolving a path and then opening it are two acts, and everything dangerous lives in
 * the gap between them. `realpath` reports a *dangling* symlink as "does not exist yet",
 * so the check concluded the path was inside the root while the write followed the link
 * straight out of it — that is how an arbitrary file write reached /etc. And even for a
 * link that resolves correctly, the target can be swapped between the check and the
 * open.
 *
 * `O_NOFOLLOW` closes both, because it makes the kernel perform the check as part of the
 * open itself: there is no window. The path handed here has already had legitimate
 * symlinks resolved away by `resolveRealWithinRoot`, so a symlink still sitting at the
 * final component is either the dangling case or a swap, and neither should be followed.
 *
 * Windows has no `O_NOFOLLOW` and Node exposes no equivalent, so there an explicit check
 * is the whole defence and it is racy. The two platforms therefore take deliberately
 * different paths — see the body. Reparse-point behaviour on a real Windows machine has
 * never been exercised; see docs/known-limitations.md and security/BACKLOG.md §1.1.
 */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const HAS_O_NOFOLLOW = O_NOFOLLOW !== 0;

const REFUSED_LINK = "Refused to follow a symbolic link at the target path.";

/**
 * Exposed for the containment tests only.
 *
 * `raceHook` runs between the pre-check and the open, which is the window an attacker
 * would use and which no test could otherwise create; `afterOpenHook` runs immediately
 * after it, which is how an attacker would cover their tracks. `forceExplicit` takes the
 * branch used where `O_NOFOLLOW` does not exist, because the suite runs where it does.
 */
export async function openContainedForTest(
  path: string,
  flags: number,
  raceHook?: () => Promise<void>,
  afterOpenHook?: () => Promise<void>,
): ReturnType<typeof openContained> {
  return openContained(path, flags, { forceExplicit: true, raceHook, afterOpenHook });
}

async function openContained(
  path: string,
  flags: number,
  test?: {
    forceExplicit?: boolean;
    raceHook?: () => Promise<void>;
    afterOpenHook?: () => Promise<void>;
  },
): Promise<{ ok: true; handle: Awaited<ReturnType<typeof open>> } | { ok: false; summary: string }> {
  if (HAS_O_NOFOLLOW && !test?.forceExplicit) {
    // No pre-check at all. `O_NOFOLLOW` *is* the check and the kernel performs it as part
    // of the open, so inspecting the path first would add a check-then-use window without
    // adding a check — which is exactly what CodeQL's js/file-system-race flagged here,
    // correctly. The refusal arrives as ELOOP from the syscall itself.
    try {
      return { ok: true, handle: await open(path, flags | O_NOFOLLOW) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") return { ok: false, summary: REFUSED_LINK };
      throw error;
    }
  }

  // Windows. There is no `O_NOFOLLOW` and Node exposes no equivalent
  // (`FILE_FLAG_OPEN_REPARSE_POINT` is not reachable through fs), so the check cannot be
  // part of the open and must be made around it.
  //
  // The pre-check cannot be dropped even though it is the racy half, because `O_CREAT`
  // through a *dangling* link creates the out-of-root file before anything could inspect
  // the result — refusing after the fact would be refusing after the escape.
  //
  // The post-check inspects the handle rather than the path, which is the part that does
  // not race: if the path was swapped for a link between the two calls, `open` followed
  // it and the handle now refers to the link's target, whose identity differs from what
  // the path names. Swapping back afterwards does not help — the handle still points at
  // the target, and mutation confirms this is the half that catches that case.
  //
  // The symlink test beside it is not redundant: it is what remains on a filesystem that
  // reports no inode, where the identity comparison compares nothing. Mutation does not
  // distinguish it on Linux for that reason.
  //
  // None of this makes the sequence atomic. It defeats the ordinary race and leaves the
  // narrow one. Stated rather than papered over: security/BACKLOG.md §1.1 and
  // docs/known-limitations.md.
  const before = await lstat(path).catch(() => null);
  if (before?.isSymbolicLink()) return { ok: false, summary: REFUSED_LINK };

  await test?.raceHook?.();

  const handle = await open(path, flags);
  await test?.afterOpenHook?.();
  const [named, opened] = await Promise.all([
    lstat(path).catch(() => null),
    handle.stat().catch(() => null),
  ]);
  const swapped =
    named?.isSymbolicLink() === true ||
    (named != null &&
      opened != null &&
      named.ino !== 0 &&
      opened.ino !== 0 &&
      (named.ino !== opened.ino || named.dev !== opened.dev));
  if (swapped) {
    await handle.close().catch(() => undefined);
    return { ok: false, summary: REFUSED_LINK };
  }
  return { ok: true, handle };
}

/**
 * The pre-image of a path that containment has already approved.
 *
 * `present: false` and `present: true, content: ""` are different facts and the
 * difference is load-bearing: rolling back a write to a file that did not exist means
 * DELETING it, while rolling back a write to a file that was empty means restoring an
 * empty file. Collapsing the two would have a rollback leave a stray file behind, or
 * delete one the user already had.
 *
 * `tooLarge` is the third honest answer — see MAX_CHECKPOINT_PRE_IMAGE_BYTES.
 */
type PreImage =
  | { present: false }
  | { present: true; content: string }
  | { tooLarge: true; sizeBytes: number }
  | { unsupported: string };

/**
 * Read the current contents of an approved target so a write can be reversed.
 *
 * Goes through `openContained` — the same primitive `readApproved` uses — and NOT
 * through `node:fs/promises.readFile`. That is not a style preference. Containment for
 * the final path component IS the `O_NOFOLLOW` inside the open: `realpath` reports a
 * *dangling* symlink as "does not exist yet", which is literally how an arbitrary file
 * write once reached /etc (see the comment on `openContained`). A plain `readFile` here
 * would reopen that hole and add a fresh check-then-use window on the read side.
 */
async function readPreImage(target: string): Promise<PreImage> {
  let opened;
  try {
    opened = await openContained(target, constants.O_RDONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The POSIX branch of openContained only translates ELOOP/EMLINK and rethrows the
    // rest, so "the file is not there yet" arrives here as a throw rather than a result.
    // That is the ordinary case for a first write, not a failure.
    if (code === "ENOENT") return { present: false };
    return { unsupported: `could not read the existing file (${code ?? "unknown error"})` };
  }
  if (!opened.ok) {
    // A symlink at the target. The write itself is about to refuse for the same reason;
    // returning "unsupported" keeps the refusal in one place rather than guessing here.
    return { unsupported: opened.summary };
  }
  try {
    const info = await opened.handle.stat();
    if (info.isDirectory()) return { unsupported: "the target is a directory" };
    if (!info.isFile()) return { unsupported: "the target is not a regular file" };
    if (info.size > MAX_CHECKPOINT_PRE_IMAGE_BYTES) {
      return { tooLarge: true, sizeBytes: info.size };
    }
    return { present: true, content: await opened.handle.readFile("utf8") };
  } catch (error) {
    return {
      unsupported: `could not read the existing file (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Read an approved path back in full, for drift detection during a rollback.
 *
 * Deliberately NOT `readApproved`: that is the model-facing tool and it truncates at
 * 8000 characters to bound what enters a prompt. Comparing a truncated read against a
 * recorded post-image would report drift on every file over 8 KB — or, with the
 * comparison the other way round, report a match for two files that differ only past
 * the cut. Neither is a drift check.
 *
 * Bounded by the same MAX_CHECKPOINT_PRE_IMAGE_BYTES as capture, because a file larger
 * than that never had a checkpoint recorded in the first place.
 */
export async function readApprovedExact(
  approvedRoots: string[],
  requested: string,
): Promise<{ ok: true; present: boolean; content: string } | { ok: false; summary: string }> {
  const resolved = await resolveApprovedPathReal(approvedRoots, requested);
  if (!resolved.ok) return { ok: false, summary: resolved.summary };
  if (isVesperOwnPath(resolved.path)) {
    return { ok: false, summary: "Refused to touch Vesper's own data or configuration." };
  }
  const pre = await readPreImage(resolved.path);
  if ("unsupported" in pre) return { ok: false, summary: pre.unsupported };
  if ("tooLarge" in pre) return { ok: false, summary: `File is larger than the ${MAX_CHECKPOINT_PRE_IMAGE_BYTES}-byte comparison limit.` };
  if (!pre.present) return { ok: true, present: false, content: "" };
  return { ok: true, present: true, content: pre.content };
}

/**
 * Remove a file, re-running the full containment chain first.
 *
 * This exists for exactly one caller: reversing a write that CREATED a file, where the
 * pre-image is "did not exist" and restoring it means deleting what Vesper made. It is
 * deliberately NOT registered as a tool. Adding an `fs_delete` the model could call
 * would widen the attack surface; a rollback path that can only remove a file it has a
 * recorded pre-image for does not.
 *
 * Containment is re-run against the roots passed in — which are the CURRENT ones, not
 * the ones in force when the checkpoint was taken. A checkpoint blob is persisted state
 * and therefore attacker-influenceable; if the approved roots have narrowed since, the
 * rollback must be refused rather than honoured against the old boundary.
 *
 * `unlink` removes a NAME, never the thing a symlink points at, so the final component
 * needs no `O_NOFOLLOW` equivalent. The parent is the part that can move underneath us,
 * and it is re-realpathed here for the same reason `writeApproved` re-checks it.
 */
export async function deleteApproved(
  approvedRoots: string[],
  requested: string,
): Promise<{ ok: true } | { ok: false; summary: string }> {
  const resolved = await resolveApprovedPathReal(approvedRoots, requested);
  if (!resolved.ok) return { ok: false, summary: resolved.summary };
  // `isVesperOwnPath` is checked lexically against the *requested* string inside
  // resolveApprovedPath. Re-check the RESOLVED path: a link inside an approved root
  // pointing at Vesper's own data would pass the first check and fail this one.
  if (isVesperOwnPath(resolved.path)) {
    return { ok: false, summary: "Refused to touch Vesper's own data or configuration." };
  }
  const parentReal = await resolveRealWithinRoot(resolved.root, dirname(resolved.path));
  if (!parentReal.ok) return { ok: false, summary: parentReal.reason };
  const target = join(parentReal.path, basename(resolved.path));
  const info = await lstat(target).catch(() => null);
  if (!info) return { ok: false, summary: "The file is already gone." };
  if (info.isSymbolicLink()) return { ok: false, summary: REFUSED_LINK };
  if (!info.isFile()) return { ok: false, summary: "Refused to remove something that is not a regular file." };
  try {
    await unlink(target);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      summary: `Could not remove file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function listApproved(
  approvedRoots: string[],
  requested: string,
): Promise<ToolExecutionResult> {
  const resolved = await resolveApprovedPathReal(approvedRoots, requested || approvedRoots[0] || "");
  if (!resolved.ok) {
    return { ok: false, epistemic: "could_not_access", summary: resolved.summary };
  }
  try {
    const entries = await readdir(resolved.path, { withFileTypes: true });
    const names = entries.slice(0, 100).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return {
      ok: true,
      epistemic: "checked",
      summary: `${names.length} entries in ${relative(resolved.root, resolved.path) || resolved.root}.`,
      data: names as unknown as JsonObject,
    };
  } catch (error) {
    return {
      ok: false,
      epistemic: "could_not_access",
      summary: `Could not list directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readApproved(
  approvedRoots: string[],
  requested: string,
): Promise<ToolExecutionResult> {
  const resolved = await resolveApprovedPathReal(approvedRoots, requested);
  if (!resolved.ok) {
    return { ok: false, epistemic: "could_not_access", summary: resolved.summary };
  }
  try {
    const opened = await openContained(resolved.path, constants.O_RDONLY);
    if (!opened.ok) {
      return { ok: false, epistemic: "could_not_access", summary: opened.summary };
    }
    const handle = opened.handle;
    try {
      const info = await handle.stat();
      if (info.isDirectory()) {
        return listApproved(approvedRoots, requested);
      }
      if (info.size > 256_000) {
        return { ok: false, epistemic: "could_not_access", summary: "File is larger than the 256 KB read limit." };
      }
      const text = await handle.readFile("utf8");
      return {
        ok: true,
        epistemic: "checked",
        summary: `Read ${relative(resolved.root, resolved.path)} (${text.length} chars).`,
        data: { path: relative(resolved.root, resolved.path), text: text.slice(0, 8000) },
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      ok: false,
      epistemic: "could_not_access",
      summary: `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * File a checkpoint for a write that has already landed, and describe honestly what
 * kind of undo the user actually has.
 *
 * The write is done by the time this runs, so nothing here can fail the operation. What
 * it can do is refuse to CLAIM reversibility Vesper cannot deliver. Three outcomes:
 *
 *   - a pre-image was captured  → checkpoint recorded, `checkpointId` returned
 *   - the file was too large    → no checkpoint, and the summary says so
 *   - the pre-image was unreadable → no checkpoint, and the summary says why
 *
 * A checkpoint whose `before` was silently truncated would be worse than none: a later
 * `rollback_apply` would report success while writing back a fragment of the file.
 */
async function recordWriteCheckpoint(
  options: WriteApprovedOptions,
  target: string,
  preImage: PreImage,
  content: string,
  summary: string,
): Promise<ToolExecutionResult> {
  const store = options.checkpointStore;
  if (!store) return { ok: true, epistemic: "changed", summary };

  if ("tooLarge" in preImage) {
    return {
      ok: true,
      epistemic: "changed",
      summary: `${summary} No undo was recorded: the previous contents were ${preImage.sizeBytes} bytes, over the ${MAX_CHECKPOINT_PRE_IMAGE_BYTES}-byte checkpoint limit.`,
      data: { path: target, checkpointed: false, reason: "pre-image too large" },
    };
  }
  if ("unsupported" in preImage) {
    return {
      ok: true,
      epistemic: "changed",
      summary: `${summary} No undo was recorded: ${preImage.unsupported}.`,
      data: { path: target, checkpointed: false, reason: preImage.unsupported },
    };
  }

  // `target` is the fully resolved real path, not the string the caller asked for. A
  // relative request binds to approvedRoots[0] during resolution, so storing the raw
  // argument would let a rollback restore a different file than the one written.
  const checkpoint = await store.snapshot({
    tool: FS_WRITE_CHECKPOINT_TOOL,
    target,
    before: preImage.present ? preImage.content : null,
    absentBefore: !preImage.present,
    workspaceId: options.workspaceId,
    correlationId: options.correlationId,
  });
  // Record the post-image. Without it the reverser must treat the state as unknown and
  // refuse every rollback — the house rule that an absent `after` means REFUSE, not
  // "no drift".
  await store.verify(checkpoint.id, content);
  return {
    ok: true,
    epistemic: "changed",
    summary,
    data: { path: target, checkpointed: true, checkpointId: checkpoint.id },
  };
}

export interface WriteApprovedOptions {
  /**
   * When present, a pre-image is captured before the write and the resulting checkpoint
   * id is returned in `data.checkpointId`. Absent — which is every embedder that builds
   * a runtime without one — leaves the behaviour and the result shape exactly as before.
   */
  checkpointStore?: CheckpointStore;
  workspaceId?: string;
  correlationId?: string;
}

export async function writeApproved(
  approvedRoots: string[],
  requested: string,
  content: string,
  dryRun?: boolean,
  options: WriteApprovedOptions = {},
): Promise<ToolExecutionResult> {
  const resolved = await resolveApprovedPathReal(approvedRoots, requested);
  if (!resolved.ok) {
    return { ok: false, epistemic: "could_not_access", summary: resolved.summary };
  }
  if (content.length > 256_000) {
    return { ok: false, epistemic: "could_not_access", summary: "Write exceeds the 256 KB limit." };
  }
  if (dryRun) {
    return {
      ok: true,
      epistemic: "requested",
      summary: `Dry-run write to ${relative(resolved.root, resolved.path)}.`,
    };
  }
  try {
    // Create the parent, then re-check it. `O_NOFOLLOW` only guards the final component,
    // so a symlinked directory anywhere above it would still put the file outside the
    // root — and mkdir -p will happily resolve through one.
    //
    // Honest note: no test in filesystem-containment.test.ts fails when this re-check is
    // removed, because every *non-racy* symlinked-parent shape is already caught earlier
    // (an existing link by resolveRealWithinRoot, a dangling one by mkdir failing
    // ENOENT). What it actually guards is the window between that first resolution and
    // this write, where the parent can be swapped for a link. That race has no
    // deterministic test here, so this is unexercised defence-in-depth — kept because
    // the window is real, and recorded as unexercised rather than presented as proven.
    const parent = dirname(resolved.path);
    await mkdir(parent, { recursive: true });
    const parentReal = await resolveRealWithinRoot(resolved.root, parent);
    if (!parentReal.ok) {
      return { ok: false, epistemic: "could_not_access", summary: parentReal.reason };
    }
    const target = join(parentReal.path, basename(resolved.path));

    // Capture the pre-image BEFORE the file is opened for writing. There is no other
    // window: the open below empties the file, so a read afterwards reports zero bytes
    // whether the file was empty, full, or absent a moment ago.
    const preImage = options.checkpointStore ? await readPreImage(target) : null;

    const opened = await openContained(target, constants.O_WRONLY | constants.O_CREAT);
    if (!opened.ok) {
      return { ok: false, epistemic: "could_not_access", summary: opened.summary };
    }
    try {
      // A hard link is not a reference to a file, it *is* the file under another name, so
      // no amount of path resolution will reveal that one of its names lives outside the
      // root. Writing through one puts the bytes somewhere containment never approved.
      // There is no portable way to ask where a file's other names are, so the only
      // honest answer is to refuse to write to a file that has more than one — a
      // condition essentially never true of a document in a notes directory.
      //
      // The open above deliberately does NOT carry O_TRUNC, and the truncation happens
      // below instead. With O_TRUNC the file was already emptied by the time this check
      // ran, so the refusal returned ok:false having destroyed the user's data — an
      // honest refusal about intent and a silent loss in fact. Truncating after the
      // check makes the refusal mean what it says.
      const info = await opened.handle.stat();
      if (info.nlink > 1) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary:
            "Refused to write to a file with more than one hard link: another of its names may be outside the approved root.",
        };
      }
      await opened.handle.truncate(0);
      // Write at an explicit position. `truncate` does not move the file offset, and
      // relying on it being 0 is the kind of assumption that survives review and fails
      // on the one platform nobody ran.
      await opened.handle.write(content, 0, "utf8");
    } finally {
      await opened.handle.close().catch(() => undefined);
    }

    const summary = `Wrote ${relative(parentReal.root, target)}.`;
    if (!options.checkpointStore || !preImage) {
      return { ok: true, epistemic: "changed", summary };
    }
    return recordWriteCheckpoint(options, target, preImage, content, summary);
  } catch (error) {
    return {
      ok: false,
      epistemic: "could_not_access",
      summary: `Could not write file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function joinApproved(root: string, child: string): string {
  return join(root, child);
}
