/**
 * Cross-process single-instance guard.
 *
 * Two Vesper hosts sharing a data directory both own `state.json`, so the second one
 * to write wins and the first one's memories, confirmations and config silently
 * disappear. The guard is a lock file created with `wx` — an atomic
 * create-if-absent — holding the owner's pid.
 *
 * A lock left behind by a crash must not brick the install, so an existing lock whose
 * pid is no longer running is treated as stale, removed, and reported to the caller
 * (that report is what the crash note is built from). The acquire loop is bounded so
 * two processes racing over the same stale lock cannot spin.
 *
 * Known limit: an operating system can reuse a pid, so a stale lock whose number has
 * been handed to an unrelated program reads as "still held" and Vesper refuses to
 * start. That is the safe direction to fail, and `--status` still reports why.
 */

import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { VESPER_VERSION } from "../version.ts";

export interface LockRecord {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  version: string;
  host: string;
}

export interface InstanceLock {
  path: string;
  record: LockRecord;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export type AcquireOutcome =
  | { ok: true; lock: InstanceLock; stale: LockRecord | null; staleReason: string | null }
  | { ok: false; reason: string; holder: LockRecord | null };

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRecord(raw: string): LockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return null;
  return {
    pid: record.pid,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    heartbeatAt: typeof record.heartbeatAt === "string" ? record.heartbeatAt : "",
    version: typeof record.version === "string" ? record.version : "unknown",
    host: typeof record.host === "string" ? record.host : "unknown",
  };
}

export async function readInstanceLock(path: string): Promise<LockRecord | null> {
  try {
    return parseRecord(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function inspectInstanceLock(
  path: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<{ present: boolean; record: LockRecord | null; live: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { present: false, record: null, live: false };
  }
  const record = parseRecord(raw);
  return { present: true, record, live: record ? isAlive(record.pid) : false };
}

export async function acquireInstanceLock(input: {
  path: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  attempts?: number;
}): Promise<AcquireOutcome> {
  const pid = input.pid ?? process.pid;
  const isAlive = input.isAlive ?? isProcessAlive;
  const now = input.now ?? (() => new Date());
  const attempts = input.attempts ?? 3;
  await mkdir(dirname(input.path), { recursive: true });

  let stale: LockRecord | null = null;
  let staleReason: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = now().toISOString();
    const record: LockRecord = {
      pid,
      startedAt,
      heartbeatAt: startedAt,
      version: VESPER_VERSION,
      host: hostname(),
    };
    try {
      const handle = await open(input.path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { ok: true, lock: makeLock(input.path, record, now), stale, staleReason };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          ok: false,
          reason: `Could not create the instance lock at ${input.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          holder: null,
        };
      }
    }

    const existing = await inspectInstanceLock(input.path, isAlive);
    if (!existing.present) continue; // Someone released it between our create and our read.
    if (existing.record && existing.record.pid !== pid && existing.live) {
      return {
        ok: false,
        reason:
          `Another Vesper instance is already running (pid ${existing.record.pid} on ${existing.record.host}, ` +
          `started ${existing.record.startedAt || "unknown"}). Stop it before starting a second one, ` +
          `or delete ${input.path} if you are certain it is gone.`,
        holder: existing.record,
      };
    }
    stale = existing.record;
    staleReason = existing.record
      ? `Lock at ${input.path} was held by pid ${existing.record.pid}, which is no longer running.`
      : `Lock at ${input.path} was unreadable and has been reclaimed.`;
    await rm(input.path, { force: true });
  }

  return {
    ok: false,
    reason: `Could not acquire the instance lock at ${input.path} after ${attempts} attempts.`,
    holder: null,
  };
}

function makeLock(path: string, record: LockRecord, now: () => Date): InstanceLock {
  let released = false;
  const lock: InstanceLock = {
    path,
    record,
    async heartbeat() {
      if (released) return;
      lock.record.heartbeatAt = now().toISOString();
      try {
        await writeFile(path, `${JSON.stringify(lock.record, null, 2)}\n`, "utf8");
      } catch {
        // A missing lock directory during shutdown must not take the host down.
      }
    },
    async release() {
      if (released) return;
      released = true;
      // Only remove a lock we still own: a reclaimed stale lock may now belong to
      // someone else, and deleting theirs would let a third instance in.
      const current = await readInstanceLock(path);
      if (current && current.pid !== record.pid) return;
      await rm(path, { force: true });
    },
  };
  return lock;
}
