/**
 * Start-on-login through the per-user Run key.
 *
 * HKCU is deliberate: Vesper never asks for administrator rights, so it registers
 * itself for the logged-in user only and can be removed without elevation.
 */

import {
  assertSingleLineArgument,
  decodeStdout,
  defaultWindowsRunner,
  failureSummary,
  type WindowsCommand,
  type WindowsRunner,
} from "./exec.ts";

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE_NAME = "Vesper";

export interface StartupPreference {
  enabled: boolean;
  applied: boolean;
  detail: string;
}

export interface StartupRegistrationState {
  registered: boolean;
  target: string | null;
  detail: string;
}

export function buildStartupAddCommand(target: string, valueName = RUN_VALUE_NAME): WindowsCommand {
  assertSingleLineArgument(target, "Startup command");
  assertSingleLineArgument(valueName, "Startup value name");
  return {
    command: "reg.exe",
    // /f overwrites an existing value; without it reg.exe blocks on a confirmation prompt.
    args: ["add", RUN_KEY, "/v", valueName, "/t", "REG_SZ", "/d", target, "/f"],
  };
}

export function buildStartupRemoveCommand(valueName = RUN_VALUE_NAME): WindowsCommand {
  assertSingleLineArgument(valueName, "Startup value name");
  return { command: "reg.exe", args: ["delete", RUN_KEY, "/v", valueName, "/f"] };
}

export function buildStartupQueryCommand(valueName = RUN_VALUE_NAME): WindowsCommand {
  assertSingleLineArgument(valueName, "Startup value name");
  return { command: "reg.exe", args: ["query", RUN_KEY, "/v", valueName] };
}

/**
 * reg.exe prints `    Vesper    REG_SZ    C:\path\vesper-host.cmd`, with the value data
 * running to end of line so it may itself contain spaces.
 */
export function parseStartupQuery(stdout: string, valueName = RUN_VALUE_NAME): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/);
    if (!match) continue;
    if (match[1]?.toLowerCase() !== valueName.toLowerCase()) continue;
    const value = match[2] ?? "";
    return value.length > 0 ? value : null;
  }
  return null;
}

export async function applyStartupRegistration(input: {
  enabled: boolean;
  target: string;
  platform?: NodeJS.Platform;
  valueName?: string;
  runner?: WindowsRunner;
}): Promise<StartupPreference> {
  const platform = input.platform ?? process.platform;
  const valueName = input.valueName ?? RUN_VALUE_NAME;
  if (platform !== "win32") {
    return {
      enabled: input.enabled,
      applied: false,
      detail: `Start on login is a Windows registry feature; nothing was written on ${platform}.`,
    };
  }
  const runner = input.runner ?? defaultWindowsRunner;
  let command: WindowsCommand;
  try {
    command = input.enabled
      ? buildStartupAddCommand(input.target, valueName)
      : buildStartupRemoveCommand(valueName);
  } catch (error) {
    return {
      enabled: input.enabled,
      applied: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const result = await runner(command);
  if (!result.ok) {
    // Deleting a value that was never written is a success from the caller's view.
    if (!input.enabled && /cannot find|unable to find/i.test(`${result.stderr} ${decodeStdout(result)}`)) {
      return {
        enabled: false,
        applied: true,
        detail: `No ${RUN_KEY}\\${valueName} entry existed; start on login is off.`,
      };
    }
    return {
      enabled: input.enabled,
      applied: false,
      detail: failureSummary(result, `reg.exe ${command.args[0]}`),
    };
  }
  return {
    enabled: input.enabled,
    applied: true,
    detail: input.enabled
      ? `Wrote ${RUN_KEY}\\${valueName} = ${input.target}.`
      : `Removed ${RUN_KEY}\\${valueName}.`,
  };
}

export async function readStartupRegistration(input?: {
  platform?: NodeJS.Platform;
  valueName?: string;
  runner?: WindowsRunner;
}): Promise<StartupRegistrationState> {
  const platform = input?.platform ?? process.platform;
  const valueName = input?.valueName ?? RUN_VALUE_NAME;
  if (platform !== "win32") {
    return {
      registered: false,
      target: null,
      detail: `The Run key only exists on Windows; not checked on ${platform}.`,
    };
  }
  const runner = input?.runner ?? defaultWindowsRunner;
  const result = await runner(buildStartupQueryCommand(valueName));
  if (!result.ok) {
    return { registered: false, target: null, detail: `No ${RUN_KEY}\\${valueName} entry.` };
  }
  const target = parseStartupQuery(decodeStdout(result), valueName);
  return target
    ? { registered: true, target, detail: `${RUN_KEY}\\${valueName} = ${target}` }
    : { registered: false, target: null, detail: `No ${RUN_KEY}\\${valueName} entry.` };
}

/**
 * Preference-only view, for callers that report configuration without touching the
 * registry. `applyStartupRegistration` is what actually writes.
 */
export function describeStartupRegistration(input: {
  enabled: boolean;
  platform?: NodeJS.Platform;
}): StartupPreference {
  const platform = input.platform ?? process.platform;
  if (!input.enabled) {
    return {
      enabled: false,
      applied: false,
      detail: "Start on login is off. No OS startup entry was written.",
    };
  }
  if (platform !== "win32") {
    return {
      enabled: true,
      applied: false,
      detail:
        "Start on login is preferred, but this host is not Windows. The HKCU Run key was not written.",
    };
  }
  return {
    enabled: true,
    applied: false,
    detail: `Start on login is preferred. Call applyStartupRegistration to write ${RUN_KEY}\\${RUN_VALUE_NAME}.`,
  };
}
