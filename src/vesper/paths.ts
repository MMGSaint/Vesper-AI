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
  // A test or a developer running against a scratch directory can point every dir at
  // one place with a single env var. Never consulted in production because
  // resolveVesperDirs is called with production:true from host/main.ts, which routes
  // through the LOCALAPPDATA/XDG branches above instead.
  if (env.VESPER_DATA_DIR) {
    return layout(env.VESPER_DATA_DIR);
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

/**
 * The revocation list's own file.
 *
 * Deliberately not a key inside state.json. Revocation is documented as terminal, but
 * that guarantee lived entirely in one record inside one value in one file: a truncated
 * state.json cost the record, and losing the record let a device the owner had declared
 * lost re-enrol. Two files fail independently; one does not.
 */
export function revokedDevicesFile(dirs: VesperDirs): string {
  return join(dirs.data, "revoked-devices.json");
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
