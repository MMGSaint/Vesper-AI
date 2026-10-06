import type { EventBus } from "../events.ts";
import type { Logger } from "../logging.ts";
import type { BackgroundHealth, BackgroundState, TrayMenuItem } from "../types.ts";
import { nowIso } from "../id.ts";
import { applyStartupRegistration, type StartupPreference } from "./startup.ts";

export interface BackgroundRuntime {
  state(): BackgroundState;
  health(): BackgroundHealth;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setStartOnLogin(value: boolean): Promise<{ ok: boolean; summary: string }>;
  startOnLogin(): boolean;
}

export function createBackgroundRuntime(input: {
  events: EventBus;
  log: Logger;
  startOnLogin?: boolean;
  startupTarget?: string;
  startupRunner?: Parameters<typeof applyStartupRegistration>[0]["runner"];
}): BackgroundRuntime {
  let state: BackgroundState = "stopped";
  let startedAt: string | null = null;
  let startOnLogin = Boolean(input.startOnLogin);

  return {
    state: () => state,
    startOnLogin: () => startOnLogin,
    health() {
      return {
        state,
        startedAt,
        paused: state === "paused",
        startOnLogin,
      };
    },
    async start() {
      if (state === "running" || state === "paused") return;
      state = "starting";
      startedAt = nowIso();
      state = "running";
      input.log.info("windows", "Background runtime started", { state });
      input.events.emit({
        type: "lifecycle.background_start",
        title: "Background runtime is running",
        severity: "info",
      });
    },
    async pause() {
      if (state !== "running") return;
      state = "paused";
      input.log.info("windows", "Background activity paused", { state });
      input.events.emit({
        type: "lifecycle.pause",
        title: "Background activity paused",
        severity: "info",
      });
    },
    async resume() {
      if (state !== "paused") return;
      state = "running";
      input.log.info("windows", "Background activity resumed", { state });
      input.events.emit({
        type: "lifecycle.resume",
        title: "Background activity resumed",
        severity: "info",
      });
    },
    async stop() {
      if (state === "stopped") return;
      state = "stopping";
      state = "stopped";
      input.log.info("windows", "Background runtime stopped", { state });
      input.events.emit({
        type: "lifecycle.background_stop",
        title: "Background runtime stopped",
        severity: "info",
      });
    },
    async setStartOnLogin(value: boolean) {
      if (!input.startupTarget) {
        startOnLogin = value;
        input.log.info("windows", "Start-on-login preference updated", { startOnLogin: value, applied: false });
        return {
          ok: true,
          summary: value
            ? "Start on login is enabled as a preference, but no startup target is attached to this runtime."
            : "Start on login preference disabled; no OS startup entry was changed.",
        };
      }
      const applied: StartupPreference = await applyStartupRegistration({
        enabled: value,
        target: input.startupTarget,
        runner: input.startupRunner,
      });
      if (applied.applied) {
        startOnLogin = value;
        input.events.emit({
          type: "lifecycle.startup_registration",
          title: value ? "Vesper will start on login" : "Vesper will no longer start on login",
          severity: "info",
        });
      }
      input.log.info("windows", "Start-on-login registration attempt", {
        requested: value,
        applied: applied.applied,
        detail: applied.detail,
      });
      return { ok: applied.applied, summary: applied.detail };
    },
  };
}

export function createTrayMenu(health: BackgroundHealth): TrayMenuItem[] {
  const running = health.state === "running";
  const paused = health.state === "paused";
  return [
    { id: "open", label: "Open Vesper", enabled: true, role: "open" },
    { id: "status", label: "Status", enabled: true, role: "status" },
    { id: "diagnostics", label: "Diagnostics", enabled: true, role: "diagnostics" },
    { id: "sep-1", label: "", enabled: false, role: "separator" },
    {
      id: "pause",
      label: paused ? "Resume background activity" : "Pause background activity",
      enabled: running || paused,
      role: paused ? "resume" : "pause",
    },
    {
      id: "startup",
      label: health.startOnLogin ? "Disable start on login" : "Enable start on login",
      enabled: true,
      role: "startup",
    },
    { id: "sep-2", label: "", enabled: false, role: "separator" },
    { id: "exit", label: "Exit", enabled: true, role: "exit" },
  ];
}

export async function invokeTrayAction(
  role: TrayMenuItem["role"],
  runtime: BackgroundRuntime,
): Promise<{ ok: boolean; summary: string; action: string }> {
  switch (role) {
    case "pause":
      await runtime.pause();
      return { ok: true, summary: "Background activity paused.", action: "pause" };
    case "resume":
      await runtime.resume();
      return { ok: true, summary: "Background activity resumed.", action: "resume" };
    case "startup": {
      const next = !runtime.startOnLogin();
      const result = await runtime.setStartOnLogin(next);
      return {
        ok: result.ok,
        summary: result.summary,
        action: "startup",
      };
    }
    case "exit":
      await runtime.stop();
      return { ok: true, summary: "Vesper background runtime stopped.", action: "exit" };
    case "open":
      return { ok: true, summary: "Open Vesper requested.", action: "open" };
    case "status":
      return { ok: true, summary: `Background state: ${runtime.state()}.`, action: "status" };
    case "diagnostics":
      return { ok: true, summary: "Diagnostics requested.", action: "diagnostics" };
    default:
      return { ok: false, summary: "Unknown tray action.", action: "unknown" };
  }
}
