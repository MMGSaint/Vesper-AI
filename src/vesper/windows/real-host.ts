/**
 * The real Windows host adapter.
 *
 * `WindowsHost` is synchronous because the tool layer calls it inside a tool handler,
 * but tasklist, taskkill and a toast are all subprocesses. So this adapter splits the
 * two honestly:
 *
 *   - `launch` genuinely is synchronous — a detached spawn returns immediately and
 *     either succeeded or threw.
 *   - `listProcesses` returns the most recent refresh. It is empty until
 *     `refreshProcesses()` has run once, and says so rather than inventing a list.
 *   - `close` and `notify` dispatch and report *dispatch*, never delivery. The real
 *     outcome arrives through `onAsyncResult`, which the host service logs.
 *
 * Nothing here has run on Windows: the target PC is offline. Command construction and
 * output parsing are unit-tested against a fake runner; execution needs first-boot
 * validation on the real machine.
 */

import type { ApprovedApp, ProcessInfo, VesperNotification } from "../types.ts";
import { createHostNotificationAdapter, type HostNotificationAdapter } from "./notifications.ts";
import {
  assertApprovedExecutable,
  closeWindowsProcess,
  defaultDetachedLauncher,
  listWindowsProcesses,
  type DetachedLauncher,
} from "./process.ts";
import { defaultWindowsRunner, type WindowsRunner } from "./exec.ts";

export interface AsyncHostResult {
  action: "close" | "notify" | "refresh";
  ok: boolean;
  summary: string;
}

export interface RealWindowsHostOptions {
  platform?: NodeJS.Platform;
  runner?: WindowsRunner;
  launcher?: DetachedLauncher;
  nativeNotifications?: boolean;
  enableTray?: boolean;
  toastAppId?: string;
  onAsyncResult?: (result: AsyncHostResult) => void;
}

export interface RealWindowsHost {
  platform: string;
  simulated: boolean;
  trayAvailable: boolean;
  notificationsAvailable: boolean;
  notificationAdapter: HostNotificationAdapter;
  listProcesses(): ProcessInfo[];
  launch(app: ApprovedApp): { ok: boolean; summary: string };
  close(name: string): { ok: boolean; summary: string };
  notify(title: string, body: string, kind?: VesperNotification["kind"]): { ok: boolean; summary: string };
  /** Refresh the process cache from tasklist. Safe to call on a timer. */
  refreshProcesses(): Promise<{ ok: boolean; count: number; detail: string }>;
  /** Awaitable variants, used by tests and by callers that can wait. */
  closeAsync(name: string): Promise<{ ok: boolean; summary: string }>;
  notifyAsync(title: string, body: string): Promise<{ ok: boolean; summary: string }>;
  lastProcessRefresh(): { at: string | null; ok: boolean; detail: string };
}

export function createRealWindowsHost(options?: RealWindowsHostOptions): RealWindowsHost {
  const platform = options?.platform ?? process.platform;
  const runner = options?.runner ?? defaultWindowsRunner;
  const launcher = options?.launcher ?? defaultDetachedLauncher;
  const report = options?.onAsyncResult ?? (() => {});
  const adapter = createHostNotificationAdapter({
    platform,
    enabled: options?.nativeNotifications ?? true,
    appId: options?.toastAppId,
    runner,
  });

  let processes: ProcessInfo[] = [];
  let refreshedAt: string | null = null;
  let refreshOk = false;
  let refreshDetail = "tasklist has not run yet.";

  const host: RealWindowsHost = {
    platform,
    simulated: false,
    trayAvailable: (options?.enableTray ?? true) && platform === "win32",
    notificationsAvailable: adapter.available,
    notificationAdapter: adapter,

    listProcesses() {
      return processes;
    },

    async refreshProcesses() {
      const result = await listWindowsProcesses({ platform, runner });
      refreshedAt = new Date().toISOString();
      refreshOk = result.ok;
      refreshDetail = result.detail;
      if (result.ok) processes = result.processes;
      report({ action: "refresh", ok: result.ok, summary: result.detail });
      return { ok: result.ok, count: result.processes.length, detail: result.detail };
    },

    lastProcessRefresh() {
      return { at: refreshedAt, ok: refreshOk, detail: refreshDetail };
    },

    launch(app) {
      try {
        assertApprovedExecutable(app.executable);
      } catch (error) {
        return { ok: false, summary: error instanceof Error ? error.message : String(error) };
      }
      if (platform !== "win32") {
        return { ok: false, summary: `Launching ${app.name} is Windows-only; not attempted on ${platform}.` };
      }
      const launched = launcher(app.executable, []);
      return launched.ok
        ? { ok: true, summary: `Launched ${app.name} (pid ${launched.pid ?? "unknown"}).` }
        : { ok: false, summary: `Could not launch ${app.name}: ${launched.error ?? "unknown error"}.` };
    },

    async closeAsync(name) {
      return closeWindowsProcess({ executable: name, platform, runner });
    },

    close(name) {
      if (platform !== "win32") {
        return { ok: false, summary: `Closing ${name} is Windows-only; not attempted on ${platform}.` };
      }
      void host
        .closeAsync(name)
        .then((result) => report({ action: "close", ok: result.ok, summary: result.summary }))
        .catch((error: unknown) =>
          report({
            action: "close",
            ok: false,
            summary: error instanceof Error ? error.message : String(error),
          }),
        );
      return {
        ok: true,
        summary: `Asked Windows to close ${name}. The result is reported asynchronously in the audit log.`,
      };
    },

    async notifyAsync(title, body) {
      return adapter.notify(title, body);
    },

    notify(title, body) {
      if (!adapter.available) {
        return { ok: false, summary: "Notifications are unavailable on this host." };
      }
      void host
        .notifyAsync(title, body)
        .then((result) => report({ action: "notify", ok: result.ok, summary: result.summary }))
        .catch((error: unknown) =>
          report({
            action: "notify",
            ok: false,
            summary: error instanceof Error ? error.message : String(error),
          }),
        );
      return {
        ok: true,
        summary: `Toast dispatched: ${title}. Delivery is reported asynchronously in the audit log.`,
      };
    },
  };

  return host;
}
