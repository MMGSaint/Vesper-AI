/**
 * Live Windows process control: list, launch, close.
 *
 * Every executable name that reaches this module has already been matched against the
 * approved-application catalog, and is checked again here with `isSafeExecutableName`
 * before it becomes argv[0] — a name carrying a path separator or a shell
 * metacharacter is refused rather than sanitised.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { isSafeExecutableName, parseTasklistCsv } from "../security.ts";
import type { ProcessInfo } from "../types.ts";
import {
  decodeStdout,
  defaultWindowsRunner,
  failureSummary,
  type WindowsCommand,
  type WindowsRunner,
} from "./exec.ts";

export { parseTasklistCsv };

export interface DetachedLaunch {
  ok: boolean;
  pid: number | null;
  error: string | null;
}

/**
 * Launching is not the same as running a command: the child outlives Vesper, so it is
 * spawned detached with its stdio closed and then unreferenced.
 */
export type DetachedLauncher = (command: string, args: string[]) => DetachedLaunch;

export const defaultDetachedLauncher: DetachedLauncher = (command, args) => {
  try {
    const child = nodeSpawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: false,
    });
    child.unref();
    return { ok: true, pid: child.pid ?? null, error: null };
  } catch (error) {
    return { ok: false, pid: null, error: error instanceof Error ? error.message : String(error) };
  }
};

export function buildTasklistCommand(): WindowsCommand {
  return { command: "tasklist.exe", args: ["/FO", "CSV", "/NH"], timeoutMs: 10_000 };
}

export function buildTaskkillCommand(executable: string, options?: { force?: boolean }): WindowsCommand {
  assertApprovedExecutable(executable);
  // /T takes the process tree with it; /F is only added when a polite close failed.
  const args = ["/IM", executable, "/T"];
  if (options?.force) args.push("/F");
  return { command: "taskkill.exe", args, timeoutMs: 10_000 };
}

export async function listWindowsProcesses(input?: {
  platform?: NodeJS.Platform;
  runner?: WindowsRunner;
}): Promise<{ ok: boolean; processes: ProcessInfo[]; detail: string }> {
  const platform = input?.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      ok: false,
      processes: [],
      detail: "Live process listing is Windows-only. Using the simulated host on this machine.",
    };
  }
  const runner = input?.runner ?? defaultWindowsRunner;
  const result = await runner(buildTasklistCommand());
  if (!result.ok) {
    return { ok: false, processes: [], detail: failureSummary(result, "tasklist") };
  }
  const processes = parseTasklistCsv(decodeStdout(result)).map((row) => ({
    pid: row.pid,
    name: row.name,
    memoryMB: row.memoryMB,
  }));
  return { ok: true, processes, detail: `${processes.length} processes.` };
}

export async function closeWindowsProcess(input: {
  executable: string;
  platform?: NodeJS.Platform;
  runner?: WindowsRunner;
}): Promise<{ ok: boolean; summary: string }> {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: false, summary: `Closing a live process is Windows-only; not attempted on ${platform}.` };
  }
  let command: WindowsCommand;
  try {
    command = buildTaskkillCommand(input.executable);
  } catch (error) {
    return { ok: false, summary: error instanceof Error ? error.message : String(error) };
  }
  const runner = input.runner ?? defaultWindowsRunner;
  const result = await runner(command);
  if (result.ok) {
    return { ok: true, summary: `Asked Windows to close ${input.executable}.` };
  }
  const output = `${decodeStdout(result)} ${result.stderr}`;
  if (/not found|no running instance/i.test(output)) {
    return { ok: false, summary: `${input.executable} is not running.` };
  }
  return { ok: false, summary: failureSummary(result, `taskkill ${input.executable}`) };
}

export function assertApprovedExecutable(executable: string): string {
  if (!isSafeExecutableName(executable)) {
    throw new Error("Executable name is not safe to spawn.");
  }
  return executable;
}
