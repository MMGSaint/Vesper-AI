import { join } from "node:path";
import { resolveVesperDirs } from "../paths.ts";
import type { VesperDirs } from "../types.ts";

export interface PackagingStep {
  id: string;
  title: string;
  privileged: boolean;
  applied: boolean;
  detail: string;
}

export interface PackagingPlan {
  kind: "install" | "uninstall" | "reset";
  root: string;
  dirs: VesperDirs;
  steps: PackagingStep[];
  notes: string[];
}

export function describeInstallPlan(input?: {
  platform?: NodeJS.Platform;
  registerStartup?: boolean;
  env?: NodeJS.ProcessEnv;
}): PackagingPlan {
  const platform = input?.platform ?? process.platform;
  const dirs = resolveVesperDirs({
    production: true,
    platform,
    env: input?.env ?? { LOCALAPPDATA: "%LOCALAPPDATA%" },
  });
  const onWindows = platform === "win32";
  const steps: PackagingStep[] = [
    step("dirs", "Create config/data/logs/models/bin", false, false, `Root ${dirs.root}`),
    step("config", "Write default vesper.config.json if missing", false, false, "Does not overwrite an existing config."),
    step("launcher", "Write vesper-host.cmd", false, false, join(dirs.root, "bin", "vesper-host.cmd")),
    step(
      "startup",
      "Optional HKCU Run registration",
      false,
      false,
      input?.registerStartup
        ? onWindows
          ? "Would write HKCU\\...\\Run\\Vesper. Not applied from this host."
          : "Startup registration is Windows-only."
        : "Not requested.",
    ),
  ];
  return {
    kind: "install",
    root: dirs.root,
    dirs,
    steps,
    notes: [
      "INSTALL → LAUNCH → BOOTSTRAP → CONFIGURE → RUN",
      "Normal runtime does not require Claude, Grok, GitHub, or a browser console.",
      onWindows
        ? "This plan is hardware-dependent until executed on the target PC."
        : "This host is not Windows. Scripts exist but were not executed.",
      "Does not install Ollama, llama.cpp, faster-whisper, or Piper.",
    ],
  };
}

export function describeUninstallPlan(input?: {
  purgeData?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): PackagingPlan {
  const platform = input?.platform ?? process.platform;
  const dirs = resolveVesperDirs({
    production: true,
    platform,
    env: input?.env ?? { LOCALAPPDATA: "%LOCALAPPDATA%" },
  });
  return {
    kind: "uninstall",
    root: dirs.root,
    dirs,
    steps: [
      step("startup", "Remove HKCU Run\\Vesper", false, false, "Best-effort."),
      step("launcher", "Remove vesper-host.cmd", false, false, join(dirs.root, "bin", "vesper-host.cmd")),
      step(
        "data",
        input?.purgeData ? "Delete the Vesper data root" : "Keep memory/config/logs",
        false,
        false,
        input?.purgeData ? dirs.root : "Data retained.",
      ),
    ],
    notes: ["Uninstall does not touch Mortis or the PC optimizer."],
  };
}

export function describeResetPlan(input?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): PackagingPlan {
  const platform = input?.platform ?? process.platform;
  const dirs = resolveVesperDirs({
    production: true,
    platform,
    env: input?.env ?? { LOCALAPPDATA: "%LOCALAPPDATA%" },
  });
  return {
    kind: "reset",
    root: dirs.root,
    dirs,
    steps: [
      step("health", "Clear health.json", false, false, "Runtime health file."),
      step("state", "Reset state.json after corrupt-file backup", false, false, "Memory is wiped; a .corrupt copy is kept if present."),
      step("first-boot", "Allow first-boot to run again", false, false, "Capability profile is rediscovered on next launch."),
    ],
    notes: ["Reset is local-only. It does not contact cloud AI or the optimizer API."],
  };
}

function step(
  id: string,
  title: string,
  privileged: boolean,
  applied: boolean,
  detail: string,
): PackagingStep {
  return { id, title, privileged, applied, detail };
}
