import type { SimulatedHardware } from "../hardware/simulated.ts";
import type { ProcessInfo } from "../types.ts";
import { WORKLOAD_SIGNATURES, inspectWorkload } from "./context.ts";

export interface GameDetection {
  id: string;
  label: string;
  kind: "game" | "vr" | "capture";
  running: boolean;
  observed: boolean;
}

export interface ObsState {
  running: boolean;
  recording: boolean | "unknown";
  streaming: boolean | "unknown";
  observation: string;
  inference: string | null;
}

export interface VrchatState {
  running: boolean;
  observed: boolean;
  observation: string;
}

export interface GroundedConclusion {
  statement: string;
  kind: "observed" | "inferred";
  evidence: string;
}

export interface ReadyPlan {
  target: "vrchat" | "gaming" | "streaming" | "development";
  apps: string[];
  scenario: "vrchat" | "gaming" | "streaming" | "idle";
  notes: string[];
}

export function detectCatalog(processes: ProcessInfo[]): GameDetection[] {
  const names = processes.map((proc) => proc.name);
  return WORKLOAD_SIGNATURES.map((signature) => {
    const running = names.some((name) => signature.match.test(name));
    return {
      id: signature.id,
      label: signature.label,
      kind: signature.kind,
      running,
      observed: running,
    };
  });
}

export function detectObs(
  hardware: SimulatedHardware,
): ObsState {
  const context = inspectWorkload(hardware);
  const running = context.obsRunning;
  const knownScenario = hardware.getScenario() === "streaming";
  return {
    running,
    recording: context.obsRecording,
    streaming: context.obsStreaming,
    observation: running ? "OBS process is present on the host adapter." : "OBS process is not present.",
    inference: running && !knownScenario
      ? "Recording/streaming is inferred as unknown because no capture-state API was read."
      : null,
  };
}

export function detectVrchat(hardware: SimulatedHardware): VrchatState {
  const context = inspectWorkload(hardware);
  return {
    running: context.vrchatRunning,
    observed: context.vrchatRunning,
    observation: context.vrchatRunning
      ? "VRChat.exe is present on the host adapter."
      : "VRChat is not running.",
  };
}

export function groundedConclusions(hardware: SimulatedHardware): GroundedConclusion[] {
  const snapshot = hardware.snapshot();
  const context = inspectWorkload(hardware);
  const conclusions: GroundedConclusion[] = [];

  conclusions.push({
    statement: context.vrchatRunning ? "VRChat is running." : "VRChat is not running.",
    kind: "observed",
    evidence: context.vrchatRunning
      ? "Process list includes VRChat.exe."
      : "Process list does not include VRChat.exe.",
  });

  conclusions.push({
    statement: context.obsRunning ? "OBS is running." : "OBS is not running.",
    kind: "observed",
    evidence: context.obsRunning ? "Process list includes obs64.exe." : "Process list does not include OBS.",
  });

  if (context.obsRunning) {
    conclusions.push({
      statement:
        context.obsStreaming === true
          ? "The simulator marks this as a streaming/recording scenario."
          : "OBS recording/streaming state is not confirmed.",
      kind: context.obsStreaming === true ? "inferred" : "observed",
      evidence:
        context.obsStreaming === true
          ? "Scenario is 'streaming'. Live OBS WebSocket was not queried."
          : "No OBS capture-state API was read.",
    });
  }

  if (snapshot.gpu && snapshot.gpu.utilizationPct >= 85) {
    conclusions.push({
      statement: "The workload is GPU-heavy.",
      kind: snapshot.mode === "simulated" ? "inferred" : "observed",
      evidence: `GPU utilization ${snapshot.gpu.utilizationPct}% (${snapshot.mode} snapshot).`,
    });
  }

  if (snapshot.cpu.tempC != null && snapshot.cpu.tempC >= 85) {
    conclusions.push({
      statement: "CPU temperature is elevated on this snapshot.",
      kind: snapshot.mode === "simulated" ? "inferred" : "observed",
      evidence: `CPU ${snapshot.cpu.tempC}°C (${snapshot.mode}). Live AMD telemetry was not read.`,
    });
  }

  conclusions.push({
    statement:
      snapshot.mode === "simulated"
        ? "This is a simulated snapshot. The physical PC was not queried."
        : "Hardware snapshot mode is live for this host.",
    kind: "observed",
    evidence: `hardware.mode=${snapshot.mode}`,
  });

  return conclusions;
}

export function readyPlan(target: ReadyPlan["target"]): ReadyPlan {
  const plans: Record<ReadyPlan["target"], ReadyPlan> = {
    vrchat: {
      target: "vrchat",
      apps: ["steam", "discord", "vrchat"],
      scenario: "vrchat",
      notes: [
        "Switch to the VRChat workspace.",
        "Launch approved Steam, Discord, and VRChat.",
        "Do not change optimizer profiles without confirmation.",
        "Physical launch is hardware-dependent; this host uses the simulated adapter.",
      ],
    },
    gaming: {
      target: "gaming",
      apps: ["steam", "discord"],
      scenario: "gaming",
      notes: [
        "Switch to the Gaming workspace.",
        "Launch Steam and Discord.",
        "Leave game-specific titles to the user unless named.",
      ],
    },
    streaming: {
      target: "streaming",
      apps: ["obs", "discord"],
      scenario: "streaming",
      notes: [
        "Switch to the Streaming workspace.",
        "Launch OBS and Discord.",
        "Do not start recording/streaming autonomously.",
      ],
    },
    development: {
      target: "development",
      apps: ["vscode"],
      scenario: "idle",
      notes: ["Switch to Development and launch VS Code."],
    },
  };
  return plans[target];
}

export function gpuConsumers(hardware: SimulatedHardware): { name: string; note: string }[] {
  const running = hardware.listProcesses().filter((proc) => proc.running);
  const gpuish = running.filter((proc) =>
    /vrchat|squad|obs|chrome|where.?winds/i.test(proc.name),
  );
  return gpuish.map((proc) => ({
    name: proc.title ?? proc.name,
    note: "Process is present. Live GPU-time attribution was not measured.",
  }));
}
