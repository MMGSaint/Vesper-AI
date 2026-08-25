import { readdir, writeFile, mkdir, open } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { assertWithinRoot, containsTraversal, isDangerousRoot } from "../security.ts";
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

export async function listApproved(
  approvedRoots: string[],
  requested: string,
): Promise<ToolExecutionResult> {
  const resolved = resolveApprovedPath(approvedRoots, requested || approvedRoots[0] || "");
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
  const resolved = resolveApprovedPath(approvedRoots, requested);
  if (!resolved.ok) {
    return { ok: false, epistemic: "could_not_access", summary: resolved.summary };
  }
  try {
    const handle = await open(resolved.path, "r");
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
  const resolved = resolveApprovedPath(approvedRoots, requested);
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
    await mkdir(dirname(resolved.path), { recursive: true });
    await writeFile(resolved.path, content, "utf8");
    return {
      ok: true,
      epistemic: "changed",
      summary: `Wrote ${relative(resolved.root, resolved.path)}.`,
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
