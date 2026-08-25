import type { SimulatedHardware } from "../hardware/simulated.ts";
import type { OptimizerTelemetry, WorkloadContext } from "../types.ts";

export const WORKLOAD_SIGNATURES = [
  { id: "vrchat", match: /vrchat/i, kind: "vr" as const, label: "VRChat" },
  { id: "squad", match: /squadgame|squad\.exe/i, kind: "game" as const, label: "Squad" },
  { id: "where-winds-meet", match: /where.?winds.?meet|wwm/i, kind: "game" as const, label: "Where Winds Meet" },
  { id: "obs", match: /obs64|obs32|^obs/i, kind: "capture" as const, label: "OBS" },
];

export function inspectWorkload(
  hardware: SimulatedHardware,
  options?: { optimizerActive?: boolean },
): WorkloadContext {
  const procs = hardware.listProcesses();
  const names = procs.map((proc) => proc.name.toLowerCase());
  const scenario = hardware.getScenario();
  const games: string[] = [];
  let vrchat = false;
  let obs = false;

  for (const signature of WORKLOAD_SIGNATURES) {
    if (!names.some((name) => signature.match.test(name))) continue;
    if (signature.kind === "vr") vrchat = true;
    if (signature.kind === "capture") obs = true;
    if (signature.kind === "game" || signature.kind === "vr") games.push(signature.label);
  }

  const obsKnown = scenario === "streaming";
  const gameRunning =
    games.length > 0 || scenario === "gaming" || scenario === "gpu-bound" || scenario === "vrchat";

  const notes = [
    vrchat ? "VRChat is running." : "VRChat is not running.",
    obs
      ? obsKnown
        ? "OBS is running. The simulator marks this as a streaming/recording scenario."
        : "OBS is running. Recording/streaming state is not confirmed on this host."
      : "OBS is not running.",
    gameRunning
      ? games.length
        ? `A GPU-heavy game context is present (${games.join(", ")}).`
        : "A GPU-heavy game scenario is simulated."
      : "No game process is currently detected.",
    options?.optimizerActive
      ? "The optimizer adapter is currently reachable."
      : "The optimizer is mocked or unavailable.",
  ];

  const snapshot = hardware.snapshot();
  const conclusions: WorkloadContext["conclusions"] = [
    {
      statement: vrchat ? "VRChat is running." : "VRChat is not running.",
      kind: "observed",
      evidence: vrchat ? "Process list includes VRChat.exe." : "VRChat.exe is absent.",
    },
    {
      statement: obs ? "OBS is running." : "OBS is not running.",
      kind: "observed",
      evidence: obs ? "Process list includes obs64.exe." : "OBS is absent.",
    },
  ];
  if (snapshot.gpu && snapshot.gpu.utilizationPct >= 85) {
    conclusions.push({
      statement: "The workload is GPU-heavy.",
      kind: snapshot.mode === "simulated" ? "inferred" : "observed",
      evidence: `GPU ${snapshot.gpu.utilizationPct}% (${snapshot.mode}).`,
    });
  }

  return {
    vrchatRunning: vrchat,
    obsRunning: obs,
    obsRecording: obsKnown ? true : obs ? "unknown" : false,
    obsStreaming: obsKnown ? true : obs ? "unknown" : false,
    gameRunning,
    games,
    optimizerActive: Boolean(options?.optimizerActive),
    notes,
    conclusions,
  };
}

export function formatWorkloadContext(context: WorkloadContext): string {
  return context.notes.join(" ");
}

export function explainPerformance(input: {
  bound: OptimizerTelemetry["bound"];
  context: WorkloadContext;
}): string {
  const parts: string[] = [];
  if (input.bound === "gpu") {
    parts.push(
      "The workload is currently GPU-bound, so increasing CPU performance probably will not materially help.",
    );
  } else if (input.bound === "cpu") {
    parts.push(
      "The workload is currently CPU-bound, so raising GPU power limits is unlikely to help until CPU load drops.",
    );
  } else if (input.bound === "idle") {
    parts.push("The snapshot looks idle; an aggressive performance profile is probably unnecessary.");
  } else {
    parts.push("I could not classify the bottleneck with confidence.");
  }

  if (input.context.obsRunning && input.bound !== "idle") {
    parts.push("OBS is running, which can explain extra encode/capture load around the same time.");
  }
  if (input.context.vrchatRunning) {
    parts.push("VRChat is running, so GPU time is likely going to the VR compositor and the world.");
  }
  if (input.context.gameRunning && input.context.games.length) {
    parts.push(`Detected game context: ${input.context.games.join(", ")}.`);
  }
  return parts.join(" ");
}
