import { platform } from "node:os";
import type { ApprovedApp, ProcessInfo } from "../types.ts";
import type { SimulatedHardware } from "../hardware/simulated.ts";

export interface WindowsHost {
  platform: string;
  simulated: boolean;
  trayAvailable: boolean;
  notificationsAvailable: boolean;
  listProcesses(): ProcessInfo[];
  launch(app: ApprovedApp): { ok: boolean; summary: string };
  close(name: string): { ok: boolean; summary: string };
  notify(title: string, body: string): { ok: boolean; summary: string };
}

export function createSimulatedWindowsHost(hardware: SimulatedHardware): WindowsHost {
  return {
    platform: platform(),
    simulated: true,
    trayAvailable: false,
    notificationsAvailable: false,
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
