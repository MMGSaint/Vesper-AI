/**
 * Honest health reporting.
 *
 * The old health file recorded `started: true` and never touched it again, so after a
 * crash — or after any exit that skipped the shutdown path — the file on disk still
 * claimed Vesper was running. Anything reading it was reading a lie.
 *
 * A health file is now only believable if it names a pid that is still alive *and*
 * carries a heartbeat that is recent. A reader can therefore tell "running",
 * "stopped cleanly" and "died while claiming to run" apart from the file alone.
 */

import { readFile } from "node:fs/promises";
import { isProcessAlive } from "./instance-lock.ts";

/** Written every HEARTBEAT_INTERVAL_MS; three misses is treated as not-live. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

export type HealthState = "missing" | "unreadable" | "running" | "stopped" | "dead";

export interface HealthLiveness {
  state: HealthState;
  pid: number | null;
  claimsRunning: boolean;
  processAlive: boolean;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  summary: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function assessHealth(
  payload: unknown,
  options?: { now?: Date; isAlive?: (pid: number) => boolean; staleAfterMs?: number },
): HealthLiveness {
  const record = asRecord(payload);
  if (!record) {
    return {
      state: "unreadable",
      pid: null,
      claimsRunning: false,
      processAlive: false,
      heartbeatAt: null,
      heartbeatAgeMs: null,
      summary: "The health file could not be read as an object.",
    };
  }
  const isAlive = options?.isAlive ?? isProcessAlive;
  const now = options?.now ?? new Date();
  const staleAfterMs = options?.staleAfterMs ?? HEARTBEAT_STALE_AFTER_MS;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null;
  const claimsRunning = record.started === true;
  const heartbeatAt = typeof record.heartbeatAt === "string" ? record.heartbeatAt : null;
  const beat = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(beat) ? now.getTime() - beat : null;
  const processAlive = pid !== null && isAlive(pid);

  if (!claimsRunning) {
    return {
      state: "stopped",
      pid,
      claimsRunning,
      processAlive,
      heartbeatAt,
      heartbeatAgeMs,
      summary: "Vesper recorded a clean shutdown.",
    };
  }
  if (!pid) {
    return {
      state: "dead",
      pid,
      claimsRunning,
      processAlive,
      heartbeatAt,
      heartbeatAgeMs,
      summary: "The health file claims Vesper is running but names no pid, so it cannot be trusted.",
    };
  }
  if (!processAlive) {
    return {
      state: "dead",
      pid,
      claimsRunning,
      processAlive,
      heartbeatAt,
      heartbeatAgeMs,
      summary: `The health file claims Vesper is running as pid ${pid}, but that process is gone.`,
    };
  }
  if (heartbeatAgeMs !== null && heartbeatAgeMs > staleAfterMs) {
    return {
      state: "dead",
      pid,
      claimsRunning,
      processAlive,
      heartbeatAt,
      heartbeatAgeMs,
      summary: `Pid ${pid} is alive but has not written a heartbeat for ${Math.round(heartbeatAgeMs / 1000)}s.`,
    };
  }
  return {
    state: "running",
    pid,
    claimsRunning,
    processAlive,
    heartbeatAt,
    heartbeatAgeMs,
    summary: `Vesper is running as pid ${pid}.`,
  };
}

export async function readHealthStatus(
  path: string,
  options?: { now?: Date; isAlive?: (pid: number) => boolean; staleAfterMs?: number },
): Promise<HealthLiveness> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      state: "missing",
      pid: null,
      claimsRunning: false,
      processAlive: false,
      heartbeatAt: null,
      heartbeatAgeMs: null,
      summary: `No health file at ${path}.`,
    };
  }
  try {
    return assessHealth(JSON.parse(raw), options);
  } catch {
    return {
      state: "unreadable",
      pid: null,
      claimsRunning: false,
      processAlive: false,
      heartbeatAt: null,
      heartbeatAgeMs: null,
      summary: `${path} is not valid JSON.`,
    };
  }
}
