import { platform as osPlatform } from "node:os";
import type { ApprovedApp, ProcessInfo, VesperNotification } from "../types.ts";
import type { SimulatedHardware } from "../hardware/simulated.ts";
import { createHostNotificationAdapter, type HostNotificationAdapter } from "./notifications.ts";
import { assertApprovedExecutable } from "./process.ts";
import { createRealWindowsHost, type RealWindowsHostOptions } from "./real-host.ts";

export interface WindowsHost {
  platform: string;
  simulated: boolean;
  trayAvailable: boolean;
  notificationsAvailable: boolean;
  listProcesses(): ProcessInfo[];
  launch(app: ApprovedApp): { ok: boolean; summary: string };
  close(name: string): { ok: boolean; summary: string };
  notify(title: string, body: string, kind?: VesperNotification["kind"]): { ok: boolean; summary: string };
  notificationAdapter: HostNotificationAdapter;
  /**
   * Present only on the real adapter: refills the process cache from tasklist. The
   * simulated host reads its list straight out of the fake hardware and has nothing
   * to refresh.
   */
  refreshProcesses?(): Promise<{ ok: boolean; count: number; detail: string }>;
}

export function createSimulatedWindowsHost(
  hardware: SimulatedHardware,
  options?: { platform?: NodeJS.Platform; nativeNotifications?: boolean },
): WindowsHost {
  const hostPlatform = options?.platform ?? osPlatform();
  const adapter = createHostNotificationAdapter({
    // The simulated host must never reach the real toast pipeline, even when it is
    // constructed on Windows for a test.
    platform: "linux",
    enabled: options?.nativeNotifications ?? true,
  });
  return {
    platform: hostPlatform,
    simulated: true,
    trayAvailable: hostPlatform === "win32",
    notificationsAvailable: adapter.available,
    notificationAdapter: adapter,
    listProcesses() {
      return hardware.listProcesses().map((proc) => ({
        pid: proc.pid,
        name: proc.name,
        title: proc.title,
        cpuPct: proc.cpuPct,
        memoryMB: proc.memoryMB,
        approved: proc.approved,
      }));
    },
    launch(app) {
      try {
        assertApprovedExecutable(app.executable);
      } catch (error) {
        return { ok: false, summary: error instanceof Error ? error.message : String(error) };
      }
      const byExec = hardware.launch(app.executable);
      if (byExec.ok) return byExec;
      return hardware.launch(app.name);
    },
    close(name) {
      return hardware.close(name);
    },
    notify(title, body) {
      if (!adapter.available) {
        return { ok: false, summary: "Notifications are disabled." };
      }
      return { ok: true, summary: `Simulated notification: ${title} — ${body}` };
    },
  };
}

/**
 * Pick the host adapter for this machine. The real adapter shells out to tasklist,
 * taskkill, reg.exe and PowerShell, so it is only selected on win32; everywhere else
 * the simulated host is returned and says `simulated: true` about itself.
 */
export function createWindowsHost(
  hardware: SimulatedHardware,
  options?: RealWindowsHostOptions & { forceSimulated?: boolean },
): WindowsHost {
  const hostPlatform = options?.platform ?? osPlatform();
  if (hostPlatform !== "win32" || options?.forceSimulated) {
    return createSimulatedWindowsHost(hardware, {
      platform: hostPlatform,
      nativeNotifications: options?.nativeNotifications,
    });
  }
  return createRealWindowsHost({ ...options, platform: hostPlatform });
}
