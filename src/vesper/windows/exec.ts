/**
 * One place where every Windows integration reaches the operating system.
 *
 * The rule for this whole directory: a command is an executable name plus an argv
 * array, never a string handed to a shell. Titles, application names and registry
 * values come from the user or the model, so building a command line out of them
 * would be an injection hole. Anything that must carry free text (a toast body) is
 * passed on stdin as JSON instead of being interpolated into an argument.
 *
 * The runner is injectable so command construction and output parsing can be tested
 * on a machine that has no reg.exe, tasklist or PowerShell.
 */

import { runProcess, type ProcessResult } from "../voice/process.ts";

export interface WindowsCommand {
  command: string;
  args: string[];
  /** Written to the child's stdin and then closed. Carries untrusted text safely. */
  stdin?: string;
  timeoutMs?: number;
}

export type WindowsRunner = (command: WindowsCommand) => Promise<ProcessResult>;

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export const defaultWindowsRunner: WindowsRunner = (command) =>
  runProcess({
    command: command.command,
    args: command.args,
    stdin: command.stdin,
    timeoutMs: command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: 8 * 1024 * 1024,
  });

export function decodeStdout(result: ProcessResult): string {
  return result.stdout.toString("utf8");
}

/**
 * Registry values and process names are single arguments, so a NUL or a newline in
 * them means the caller is trying to smuggle something past the argv boundary.
 */
export function assertSingleLineArgument(value: string, label: string): string {
  if (!value) throw new Error(`${label} is empty.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} contains a control character.`);
  return value;
}

export function failureSummary(result: ProcessResult, label: string): string {
  const detail = result.error ?? `exit code ${result.code}`;
  const stderr = result.stderr ? ` ${result.stderr.split(/\r?\n/)[0]}` : "";
  return `${label} failed: ${detail}.${stderr}`.trim();
}
