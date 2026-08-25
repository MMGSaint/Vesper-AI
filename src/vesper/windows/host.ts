import { platform } from "node:os";
import type { ApprovedApp, ProcessInfo } from "../types.ts";
import type { SimulatedHardware } from "../hardware/simulated.ts";
import { createHostNotificationAdapter, type HostNotificationAdapter } from "./notifications.ts";
import { assertApprovedExecutable } from "./process.ts";

export interface WindowsHost {
  platform: string;
  simulated: boolean;
  trayAvailable: boolean;
  notificationsAvailable: boolean;
  listProcesses(): ProcessInfo[];
  launch(app: ApprovedApp): { ok: boolean; summary: string };
  close(name: string): { ok: boolean; summary: string };
  notify(title: string, body: string): { ok: boolean; summary: string };
  notificationAdapter: HostNotificationAdapter;
}

export function createSimulatedWindowsHost(
  hardware: SimulatedHardware,
  options?: { platform?: NodeJS.Platform; nativeNotifications?: boolean },
): WindowsHost {
  const hostPlatform = options?.platform ?? platform();
  const adapter = createHostNotificationAdapter({
    platform: hostPlatform,
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
      return { ok: true, summary: `Simulated notification: ${title} — ${body}` };
    },
  };
}
