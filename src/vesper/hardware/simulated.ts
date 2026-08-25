import type { HardwareSnapshot } from "../types.ts";
import type { VesperConfig } from "../config.ts";

export type SimulationScenario =
  | "idle"
  | "gaming"
  | "streaming"
  | "gpu-bound"
  | "cpu-bound"
  | "vrchat"
  | "thermal";

export interface SimulatedProcess {
  pid: number;
  name: string;
  title?: string;
  running: boolean;
  cpuPct: number;
  memoryMB: number;
  approved: boolean;
}

const SCENARIOS: Record<
  SimulationScenario,
  { cpu: number; gpu: number; cpuTemp: number; gpuTemp: number; ram: number; vram: number }
> = {
  idle: { cpu: 8, gpu: 3, cpuTemp: 46, gpuTemp: 41, ram: 24, vram: 1.1 },
  gaming: { cpu: 42, gpu: 88, cpuTemp: 68, gpuTemp: 72, ram: 41, vram: 12.4 },
  streaming: { cpu: 55, gpu: 74, cpuTemp: 71, gpuTemp: 69, ram: 48, vram: 10.2 },
  "gpu-bound": { cpu: 28, gpu: 97, cpuTemp: 64, gpuTemp: 79, ram: 39, vram: 15.8 },
  "cpu-bound": { cpu: 91, gpu: 22, cpuTemp: 82, gpuTemp: 54, ram: 44, vram: 3.2 },
  vrchat: { cpu: 48, gpu: 81, cpuTemp: 70, gpuTemp: 74, ram: 52, vram: 11.6 },
  thermal: { cpu: 78, gpu: 94, cpuTemp: 91, gpuTemp: 88, ram: 50, vram: 16.1 },
};

export function createSimulatedHardware(config: VesperConfig) {
  let scenario: SimulationScenario = "idle";
  let processes: SimulatedProcess[] = defaultProcesses();

  function snapshot(): HardwareSnapshot {
    const values = SCENARIOS[scenario];
    return {
      mode: "simulated",
      os: config.hardware.target.os,
      hostname: "vesper-target-sim",
      cpu: {
        name: config.hardware.target.cpu,
        cores: 16,
        threads: 32,
        utilizationPct: values.cpu,
        tempC: values.cpuTemp,
        clocksMhz: 5200,
      },
      gpu: {
        name: config.hardware.target.gpu,
        vramGB: config.hardware.target.vramGB,
        utilizationPct: values.gpu,
        tempC: values.gpuTemp,
        vramUsedGB: values.vram,
        clocksMhz: 2400,
        powerW: scenario === "idle" ? 35 : 280,
      },
      ram: {
        totalGB: config.hardware.target.ramGB,
        usedGB: values.ram,
      },
      notes: [
        "This snapshot is simulated. The physical target PC was not queried.",
        `Scenario: ${scenario}`,
      ],
      capturedAt: new Date().toISOString(),
    };
  }

  return {
    mode: "simulated" as const,
    snapshot,
    setScenario(next: SimulationScenario) {
      scenario = next;
      syncProcesses(next);
    },
    getScenario: () => scenario,
    listProcesses: () => processes.filter((proc) => proc.running).map((proc) => ({ ...proc })),
    allProcesses: () => processes.map((proc) => ({ ...proc })),
    launch(name: string): { ok: boolean; summary: string } {
      const proc = findProcess(name);
      if (!proc) return { ok: false, summary: `No approved simulated application named '${name}'.` };
      proc.running = true;
      return { ok: true, summary: `Launched simulated application '${proc.name}'.` };
    },
    close(name: string): { ok: boolean; summary: string } {
      const proc = findProcess(name);
      if (!proc) return { ok: false, summary: `No simulated application named '${name}'.` };
      proc.running = false;
      return { ok: true, summary: `Closed simulated application '${proc.name}'.` };
    },
  };

  function findProcess(name: string) {
    const needle = name.toLowerCase();
    return processes.find(
      (proc) => proc.name.toLowerCase() === needle || proc.name.toLowerCase().includes(needle),
    );
  }

  function syncProcesses(next: SimulationScenario) {
    const runningByScenario: Record<SimulationScenario, string[]> = {
      idle: ["explorer.exe", "Code.exe"],
      gaming: ["explorer.exe", "steam.exe", "SquadGame.exe", "Discord.exe"],
      streaming: ["explorer.exe", "obs64.exe", "Discord.exe", "chrome.exe"],
      "gpu-bound": ["explorer.exe", "steam.exe", "SquadGame.exe", "obs64.exe"],
      "cpu-bound": ["explorer.exe", "Code.exe", "chrome.exe"],
      vrchat: ["explorer.exe", "VRChat.exe", "Discord.exe", "steam.exe"],
      thermal: ["explorer.exe", "SquadGame.exe", "obs64.exe", "WhereWindsMeet.exe"],
    };
    const active = new Set(runningByScenario[next]);
    for (const proc of processes) proc.running = active.has(proc.name);
  }
}

function defaultProcesses(): SimulatedProcess[] {
  return [
    { pid: 100, name: "explorer.exe", title: "Windows Explorer", running: true, cpuPct: 1, memoryMB: 180, approved: true },
    { pid: 220, name: "Discord.exe", title: "Discord", running: false, cpuPct: 4, memoryMB: 420, approved: true },
    { pid: 330, name: "obs64.exe", title: "OBS Studio", running: false, cpuPct: 12, memoryMB: 900, approved: true },
    { pid: 440, name: "steam.exe", title: "Steam", running: false, cpuPct: 3, memoryMB: 380, approved: true },
    { pid: 550, name: "SquadGame.exe", title: "Squad", running: false, cpuPct: 40, memoryMB: 6200, approved: true },
    { pid: 560, name: "WhereWindsMeet.exe", title: "Where Winds Meet", running: false, cpuPct: 38, memoryMB: 5800, approved: true },
    { pid: 660, name: "VRChat.exe", title: "VRChat", running: false, cpuPct: 35, memoryMB: 5400, approved: true },
    { pid: 770, name: "Code.exe", title: "Visual Studio Code", running: true, cpuPct: 6, memoryMB: 1100, approved: true },
    { pid: 880, name: "chrome.exe", title: "Google Chrome", running: false, cpuPct: 8, memoryMB: 1600, approved: true },
  ];
}

export type SimulatedHardware = ReturnType<typeof createSimulatedHardware>;
