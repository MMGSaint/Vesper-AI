import { readdir, mkdir, open, lstat } from "node:fs/promises";
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
  if (!lexical.ok) return lexical;
  const real = await resolveRealWithinRoot(lexical.root, lexical.path);
  if (!real.ok) return { ok: false, summary: real.reason };
  return { ok: true, path: real.path, root: real.root };
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
 * Windows has no `O_NOFOLLOW`. There the explicit lstat is the whole defence rather than
 * a nicety, and it is racy — stated plainly rather than papered over. Reparse-point
 * behaviour on a real Windows machine has never been exercised; see
 * docs/known-limitations.md.
 */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function openContained(
  path: string,
  flags: number,
): Promise<{ ok: true; handle: Awaited<ReturnType<typeof open>> } | { ok: false; summary: string }> {
  const link = await lstat(path).catch(() => null);
  if (link?.isSymbolicLink()) {
    return {
      ok: false,
      summary: "Refused to follow a symbolic link at the target path.",
    };
  }
  try {
    return { ok: true, handle: await open(path, flags | O_NOFOLLOW) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      return { ok: false, summary: "Refused to follow a symbolic link at the target path." };
    }
    throw error;
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

export async function writeApproved(
  approvedRoots: string[],
  requested: string,
  content: string,
  dryRun?: boolean,
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

    const opened = await openContained(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    );
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
      const info = await opened.handle.stat();
      if (info.nlink > 1) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary:
            "Refused to write to a file with more than one hard link: another of its names may be outside the approved root.",
        };
      }
      await opened.handle.writeFile(content, "utf8");
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
    return {
      ok: true,
      epistemic: "changed",
      summary: `Wrote ${relative(parentReal.root, target)}.`,
    };
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
