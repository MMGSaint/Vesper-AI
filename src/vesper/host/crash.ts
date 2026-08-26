/**
 * Crash detection and the note that carries it to the next start.
 *
 * Vesper has no supervisor, so an unexpected exit used to leave nothing behind but a
 * health file frozen mid-run. Two signals are recorded instead:
 *
 *   - a *live* crash: an uncaught exception or unhandled rejection writes the note on
 *     the way down;
 *   - a *post-mortem* crash: the next start finds a health file that claims to be
 *     running under a pid that is gone, or reclaims a stale instance lock.
 *
 * The note is deleted once it has been reported, so a single crash is surfaced once.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HealthLiveness } from "./health.ts";
import type { LockRecord } from "./instance-lock.ts";

export type CrashSource = "uncaught-exception" | "unhandled-rejection" | "post-mortem" | "signal";

export interface CrashNote {
  at: string;
  source: CrashSource;
  pid: number | null;
  reason: string;
  detail?: string;
  previousHeartbeatAt?: string | null;
}

export async function writeCrashNote(path: string, note: CrashNote): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(note, null, 2)}\n`, "utf8");
}

/**
 * Synchronous twin, for the one caller that matters: an `uncaughtException` handler
 * has no chance to await anything before the process goes down.
 */
export function writeCrashNoteSync(path: string, note: CrashNote): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(note, null, 2)}\n`, "utf8");
  } catch {
    // Nothing useful is left to do while the process is dying.
  }
}

export async function readCrashNote(path: string): Promise<CrashNote | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.at !== "string" || typeof record.reason !== "string") return null;
  return {
    at: record.at,
    source: (record.source as CrashSource) ?? "post-mortem",
    pid: typeof record.pid === "number" ? record.pid : null,
    reason: record.reason,
    detail: typeof record.detail === "string" ? record.detail : undefined,
    previousHeartbeatAt:
      typeof record.previousHeartbeatAt === "string" ? record.previousHeartbeatAt : null,
  };
}

export async function clearCrashNote(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Build a note from what the previous run left behind, or null when the last exit was
 * clean. A lock reclaimed from a dead pid counts even when health looks tidy, because
 * it means the shutdown path never ran.
 */
export function detectUncleanExit(input: {
  health: HealthLiveness;
  staleLock?: LockRecord | null;
  now?: Date;
}): CrashNote | null {
  const at = (input.now ?? new Date()).toISOString();
  if (input.health.state === "dead") {
    return {
      at,
      source: "post-mortem",
      pid: input.health.pid,
      reason: "Vesper exited without running its shutdown path.",
      detail: input.health.summary,
      previousHeartbeatAt: input.health.heartbeatAt,
    };
  }
  if (input.staleLock) {
    return {
      at,
      source: "post-mortem",
      pid: input.staleLock.pid,
      reason: "A previous Vesper instance left its lock behind.",
      detail: `Lock held by pid ${input.staleLock.pid} (started ${input.staleLock.startedAt || "unknown"}) was stale and reclaimed.`,
      previousHeartbeatAt: input.staleLock.heartbeatAt || null,
    };
  }
  return null;
}

export function formatCrashNote(note: CrashNote): string {
  const pid = note.pid === null ? "unknown pid" : `pid ${note.pid}`;
  const detail = note.detail ? ` ${note.detail}` : "";
  return `Previous run ended unexpectedly (${note.source}, ${pid}, ${note.at}): ${note.reason}${detail}`;
}
