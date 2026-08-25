import type { ApprovedApp, ProcessInfo } from "../types.ts";
import { isSafeExecutableName } from "../security.ts";

export interface AppDetection {
  app: ApprovedApp;
  running: boolean;
  process?: ProcessInfo;
  launchable: boolean;
  detail: string;
}

export function detectApprovedApps(
  catalog: ApprovedApp[],
  processes: ProcessInfo[],
): AppDetection[] {
  return catalog.map((app) => {
    const process = processes.find(
      (proc) =>
        proc.name.toLowerCase() === app.executable.toLowerCase() ||
        proc.name.toLowerCase() === `${app.id}.exe` ||
        app.aliases.some((alias) => proc.name.toLowerCase().includes(alias.toLowerCase())),
    );
    const launchable = isSafeExecutableName(app.executable);
    return {
      app,
      running: Boolean(process),
      process,
      launchable,
      detail: !launchable
        ? `Executable '${app.executable}' is not on the allowlist format.`
        : process
          ? `${app.name} is running (pid ${process.pid}).`
          : `${app.name} is approved but not running.`,
    };
  });
}

export function findApprovedApp(catalog: ApprovedApp[], name: string): ApprovedApp | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return catalog.find(
    (app) =>
      app.id === needle ||
      app.name.toLowerCase() === needle ||
      app.aliases.some((alias) => alias.toLowerCase() === needle),
  );
}
