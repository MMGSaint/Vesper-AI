/**
 * Size-based rotation and retention for the audit log.
 *
 * `audit.jsonl` is append-only and had no bound, so a long-lived background host grew
 * it until the disk complained. Rotation lives here, at the host level, rather than
 * inside the sink: the sink opens the file per append, so renaming it out from under
 * the sink is safe and the next entry recreates it.
 *
 * Windows will refuse to rename a file that is momentarily open, so a failed rotation
 * is reported and retried on the next check instead of taking the host down.
 */

import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AuditEntry } from "../types.ts";
import { createJsonlSink } from "../audit-file.ts";

export const DEFAULT_MAX_AUDIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_AUDIT_GENERATIONS = 5;
const ROTATION_CHECK_MS = 60_000;

export interface RotationResult {
  rotated: boolean;
  bytes: number;
  rotatedTo?: string;
  removed: string[];
  error?: string;
}

function rotatedName(path: string, stamp: string): string {
  const ext = extname(path);
  const stem = basename(path, ext);
  return join(dirname(path), `${stem}.${stamp}${ext}`);
}

function isRotationOf(path: string, candidate: string): boolean {
  const ext = extname(path);
  const stem = basename(path, ext);
  return candidate.startsWith(`${stem}.`) && candidate.endsWith(ext) && candidate !== basename(path);
}

export async function rotateAuditLog(
  path: string,
  options?: { maxBytes?: number; keep?: number; now?: Date },
): Promise<RotationResult> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_AUDIT_BYTES;
  const keep = Math.max(0, options?.keep ?? DEFAULT_AUDIT_GENERATIONS);
  let bytes = 0;
  try {
    bytes = (await stat(path)).size;
  } catch {
    return { rotated: false, bytes: 0, removed: [] };
  }
  if (bytes < maxBytes) return { rotated: false, bytes, removed: [] };

  const stamp = (options?.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const target = rotatedName(path, stamp);
  try {
    await rename(path, target);
  } catch (error) {
    return {
      rotated: false,
      bytes,
      removed: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { rotated: true, bytes, rotatedTo: target, removed: await pruneRotations(path, keep) };
}

export async function pruneRotations(path: string, keep: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dirname(path));
  } catch {
    return [];
  }
  const rotations = entries.filter((name) => isRotationOf(path, name)).sort();
  const doomed = rotations.slice(0, Math.max(0, rotations.length - keep));
  const removed: string[] = [];
  for (const name of doomed) {
    try {
      await rm(join(dirname(path), name), { force: true });
      removed.push(name);
    } catch {
      // A file another process still holds open is left for the next pass.
    }
  }
  return removed;
}

export interface RotatingAuditSink {
  sink: (entry: AuditEntry) => void;
  rotateNow(): Promise<RotationResult>;
  stop(): void;
}

export function createRotatingAuditSink(input: {
  path: string;
  maxBytes?: number;
  keep?: number;
  checkIntervalMs?: number;
  onRotate?: (result: RotationResult) => void;
}): RotatingAuditSink {
  const sink = createJsonlSink(input.path);
  const rotateNow = async () => {
    const result = await rotateAuditLog(input.path, { maxBytes: input.maxBytes, keep: input.keep });
    if (result.rotated || result.error) input.onRotate?.(result);
    return result;
  };
  // The timer must not be what keeps a background host alive.
  const timer = setInterval(() => void rotateNow(), input.checkIntervalMs ?? ROTATION_CHECK_MS);
  timer.unref?.();
  return {
    sink,
    rotateNow,
    stop() {
      clearInterval(timer);
    },
  };
}
