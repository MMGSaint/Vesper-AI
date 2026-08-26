import { homedir } from "node:os";
import { join } from "node:path";
import type { VesperDirs } from "./types.ts";

export function resolveVesperDirs(input?: {
  dataDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  production?: boolean;
}): VesperDirs {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const production = input?.production ?? env.VESPER_ENV === "production";

  if (input?.dataDir) {
    return layout(input.dataDir);
  }

  if (production && platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), "AppData", "Local");
    return layout(join(local, "Vesper"));
  }

  if (production) {
    return layout(join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vesper"));
  }

  return layout("data/vesper");
}

function layout(root: string): VesperDirs {
  return {
    root,
    config: join(root, "config"),
    data: join(root, "data"),
    logs: join(root, "logs"),
    models: join(root, "models"),
  };
}

export function healthFile(dirs: VesperDirs): string {
  return join(dirs.data, "health.json");
}

export function stateFile(dirs: VesperDirs): string {
  return join(dirs.data, "state.json");
}

export function firstBootReportFile(dirs: VesperDirs): string {
  return join(dirs.logs, "first-boot.txt");
}

export function configFile(dirs: VesperDirs): string {
  return join(dirs.config, "vesper.json");
}

export function auditLogFile(dirs: VesperDirs): string {
  return join(dirs.logs, "audit.jsonl");
}

export function instanceLockFile(dirs: VesperDirs): string {
  return join(dirs.data, "vesper.lock");
}

export function crashNoteFile(dirs: VesperDirs): string {
  return join(dirs.logs, "last-crash.json");
}

export function lastErrorFile(dirs: VesperDirs): string {
  return join(dirs.logs, "last-error.json");
}

export function transcriptFile(dirs: VesperDirs): string {
  return join(dirs.logs, "transcript.jsonl");
}
