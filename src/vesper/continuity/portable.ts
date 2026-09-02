/**
 * Portable / USB node foothold.
 *
 * A USB child must function offline from an arbitrary root. No hard-coded main-PC
 * paths. Device-local state (identity, keys) stays separate from shared state.
 *
 * This does not copy secrets onto arbitrary media. Full portable deployment is
 * not claimed until hardware testing has happened.
 */

import { isAbsolute, join } from "node:path";
import type { VesperDirs } from "../types.ts";
import { resolveVesperDirs } from "../paths.ts";

export const PORTABLE_ENV = "VESPER_PORTABLE_ROOT";

export function isPortableEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[PORTABLE_ENV]?.trim());
}

export function resolvePortableDirs(input?: {
  root?: string;
  env?: NodeJS.ProcessEnv;
}): VesperDirs | null {
  const env = input?.env ?? process.env;
  const root = (input?.root ?? env[PORTABLE_ENV] ?? "").trim();
  if (!root) return null;
  return portableLayout(root);
}

export function portableLayout(root: string): VesperDirs {
  const base = root;
  return {
    root: base,
    config: join(base, "config"),
    data: join(base, "data"),
    logs: join(base, "logs"),
    models: join(base, "models"),
  };
}

/**
 * Resolve dirs for this process: portable root wins when set, otherwise the
 * existing Vesper layout. A portable node never falls back to a main-PC
 * LOCALAPPDATA path while VESPER_PORTABLE_ROOT is set.
 */
export function resolveNodeDirs(input?: {
  dataDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  production?: boolean;
}): { dirs: VesperDirs; portable: boolean } {
  const portable = resolvePortableDirs({ env: input?.env });
  if (portable) return { dirs: portable, portable: true };
  return { dirs: resolveVesperDirs(input), portable: false };
}

export function assertRelativeSafe(path: string, root: string): boolean {
  if (!path) return false;
  if (isAbsolute(path) && !path.toLowerCase().startsWith(root.toLowerCase())) return false;
  if (path.includes("..")) return false;
  return true;
}

export function sharedStateFile(dirs: VesperDirs): string {
  return join(dirs.data, "shared-state.json");
}

export function localStateFile(dirs: VesperDirs): string {
  return join(dirs.data, "device-local.json");
}

export function portableIdentityFile(dirs: VesperDirs): string {
  return join(dirs.data, "device-identity.json");
}
