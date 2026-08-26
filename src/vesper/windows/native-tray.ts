/**
 * System tray integration.
 *
 * Chosen mechanism: a long-lived PowerShell helper (`packaging/windows/tray-host.ps1`)
 * that owns a `System.Windows.Forms.NotifyIcon` and talks to Vesper over stdin/stdout
 * with one JSON object per line. It was chosen over the alternatives because Vesper
 * ships no native modules and no Electron: a WinForms host is already present on every
 * Windows install, needs no compiler, and keeps the GUI message pump out of Node.
 *
 * Protocol (Vesper → helper):  {"type":"menu","items":[...]}  {"type":"tip","text":"…"}  {"type":"exit"}
 * Protocol (helper → Vesper):  {"type":"click","id":"pause"}  {"type":"ready"}  {"type":"error","message":"…"}
 *
 * The helper script is real and the command construction and protocol handling are
 * unit-tested here. Nothing has displayed an icon: Shell_NotifyIcon needs the target
 * Windows PC, so on any other platform this returns an adapter that says
 * `available: false` and refuses to pretend otherwise.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import type { BackgroundHealth, TrayMenuItem } from "../types.ts";
import { createTrayMenu } from "./runtime.ts";

export const TRAY_SCRIPT_RELATIVE_PATH = join("packaging", "windows", "tray-host.ps1");

export type TrayEvent =
  | { type: "ready" }
  | { type: "click"; id: string }
  | { type: "error"; message: string };

export interface TrayProcessHandle {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

export type TraySpawner = (command: string, args: string[]) => TrayProcessHandle;

export interface TrayBackend {
  id: string;
  available: boolean;
  /** Why the backend is unavailable, when it is. Empty string when it is available. */
  unavailableReason: string;
  start(items: TrayMenuItem[], onEvent: (event: TrayEvent) => void): { ok: boolean; summary: string };
  update(items: TrayMenuItem[]): { ok: boolean; summary: string };
  stop(): void;
}

export interface NativeTrayAdapter {
  available: boolean;
  applied: boolean;
  platform: string;
  backend: TrayBackend;
  menu(health: BackgroundHealth): TrayMenuItem[];
  attach(health: BackgroundHealth, onEvent?: (event: TrayEvent) => void): { ok: boolean; summary: string };
  detach(): void;
}

export function buildTrayHostCommand(scriptPath: string): { command: string; args: string[] } {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  };
}

export function serializeTrayMenu(items: TrayMenuItem[]): string {
  return `${JSON.stringify({
    type: "menu",
    items: items.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: item.enabled,
      role: item.role,
    })),
  })}\n`;
}

export function parseTrayEvent(line: string): TrayEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: "error", message: `Tray helper wrote a non-JSON line: ${trimmed.slice(0, 120)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type === "ready") return { type: "ready" };
  if (record.type === "click" && typeof record.id === "string") return { type: "click", id: record.id };
  if (record.type === "error") {
    return { type: "error", message: typeof record.message === "string" ? record.message : "Tray helper error." };
  }
  return null;
}

export const defaultTraySpawner: TraySpawner = (command, args) => {
  const child = nodeSpawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  return {
    write(line) {
      child.stdin?.write(line);
    },
    onLine(handler) {
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          handler(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      });
    },
    onExit(handler) {
      child.on("close", (code) => handler(code));
    },
    kill() {
      try {
        child.stdin?.write(`${JSON.stringify({ type: "exit" })}\n`);
        child.stdin?.end();
      } catch {
        /* the helper is already gone */
      }
      child.kill();
    },
  };
};

export function createUnavailableTrayBackend(reason: string): TrayBackend {
  return {
    id: "unavailable",
    available: false,
    unavailableReason: reason,
    start: () => ({ ok: false, summary: reason }),
    update: () => ({ ok: false, summary: reason }),
    stop: () => {},
  };
}

export function createPowerShellTrayBackend(input?: {
  scriptPath?: string;
  spawner?: TraySpawner;
  platform?: NodeJS.Platform;
}): TrayBackend {
  const platform = input?.platform ?? process.platform;
  if (platform !== "win32") {
    return createUnavailableTrayBackend(
      `The WinForms tray helper only runs on Windows; no icon was created on ${platform}.`,
    );
  }
  const scriptPath = input?.scriptPath ?? TRAY_SCRIPT_RELATIVE_PATH;
  const spawner = input?.spawner ?? defaultTraySpawner;
  let handle: TrayProcessHandle | null = null;

  return {
    id: "powershell-notifyicon",
    available: true,
    unavailableReason: "",
    start(items, onEvent) {
      if (handle) return { ok: true, summary: "Tray helper is already running." };
      const { command, args } = buildTrayHostCommand(scriptPath);
      try {
        handle = spawner(command, args);
      } catch (error) {
        handle = null;
        return {
          ok: false,
          summary: `Could not start the tray helper: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      handle.onLine((line) => {
        const event = parseTrayEvent(line);
        if (event) onEvent(event);
      });
      handle.onExit(() => {
        handle = null;
      });
      handle.write(serializeTrayMenu(items));
      return { ok: true, summary: `Tray helper started from ${scriptPath}.` };
    },
    update(items) {
      if (!handle) return { ok: false, summary: "Tray helper is not running." };
      handle.write(serializeTrayMenu(items));
      return { ok: true, summary: "Tray menu updated." };
    },
    stop() {
      handle?.kill();
      handle = null;
    },
  };
}

export function createNativeTrayAdapter(input?: {
  platform?: NodeJS.Platform;
  enableTray?: boolean;
  backend?: TrayBackend;
  scriptPath?: string;
  spawner?: TraySpawner;
}): NativeTrayAdapter {
  const platform = input?.platform ?? process.platform;
  const enabled = input?.enableTray ?? true;
  const backend = !enabled
    ? createUnavailableTrayBackend("Tray is disabled in configuration.")
    : (input?.backend ??
      createPowerShellTrayBackend({ platform, scriptPath: input?.scriptPath, spawner: input?.spawner }));

  let applied = false;
  const adapter: NativeTrayAdapter = {
    get available() {
      return backend.available;
    },
    get applied() {
      return applied;
    },
    platform,
    backend,
    menu: (health) => createTrayMenu(health),
    attach(health, onEvent) {
      const items = createTrayMenu(health);
      if (!backend.available) {
        return { ok: false, summary: backend.unavailableReason };
      }
      if (applied) return backend.update(items);
      const started = backend.start(items, onEvent ?? (() => {}));
      applied = started.ok;
      return started;
    },
    detach() {
      backend.stop();
      applied = false;
    },
  };
  return adapter;
}
