import type {
  BackgroundState,
  CapabilityProfile,
  DiagnosticReport,
  FeatureStatus,
  OptimizerStatus,
  WorkloadContext,
} from "./types.ts";

export function buildDiagnostics(input: {
  instanceId: string;
  started: boolean;
  health: BackgroundState;
  models: { active: string; available: { id: string; kind: string; available: boolean }[] };
  memory: { persistent: number; session: number };
  tools: { count: number };
  permissions: { neverAllowAutonomous: string[] };
  optimizer: OptimizerStatus;
  windows: DiagnosticReport["windows"];
  voice: DiagnosticReport["voice"];
  knowledge: DiagnosticReport["knowledge"];
  context: WorkloadContext;
  capability: CapabilityProfile | null;
  recentErrors: { at: string; message: string }[];
}): DiagnosticReport {
  const classification: Record<string, FeatureStatus> = {
    runtime: "implemented_tested",
    memory: "implemented_tested",
    permissions: "implemented_tested",
    models: input.models.available.some((item) => item.kind === "local" && item.available)
      ? "implemented_hardware_dependent"
      : "implemented_tested",
    optimizer: input.optimizer.mode === "mock" ? "mocked_simulated" : input.optimizer.available
      ? "implemented_hardware_dependent"
      : "mocked_simulated",
    windows: input.windows.simulated ? "mocked_simulated" : "implemented_hardware_dependent",
    // The software half - turning an audio buffer into text and back - is implemented
    // and tested against real subprocesses. Whether it runs on a given host depends on
    // an installed backend and, ultimately, on audio devices nothing here has opened.
    voice: "implemented_hardware_dependent",
    knowledge: "implemented_tested",
    telemetry: input.capability?.telemetry ?? "mocked_simulated",
  };

  const report: DiagnosticReport = {
    generatedAt: new Date().toISOString(),
    runtime: {
      instanceId: input.instanceId,
      started: input.started,
      health: input.health,
    },
    models: input.models,
    memory: input.memory,
    tools: input.tools,
    permissions: input.permissions,
    optimizer: input.optimizer,
    windows: input.windows,
    voice: input.voice,
    knowledge: input.knowledge,
    context: input.context,
    capability: input.capability,
    recentErrors: input.recentErrors,
    classification,
    reportText: "",
  };
  report.reportText = formatDiagnostics(report);
  return report;
}

export function formatDiagnostics(report: DiagnosticReport): string {
  const lines = [
    "Vesper diagnostics",
    `Runtime: ${report.runtime.started ? "started" : "stopped"} (${report.runtime.health}).`,
    `Models: active ${report.models.active}. ${report.models.available
      .map((item) => `${item.id}=${item.available ? "up" : "down"}`)
      .join(", ") || "none"}.`,
    `Memory: ${report.memory.persistent} persistent, ${report.memory.session} session.`,
    `Tools: ${report.tools.count} registered. High-risk tools stay never-autonomous.`,
    `Optimizer: ${report.optimizer.available ? report.optimizer.detail : "unavailable — assistant continues"}.`,
    `Windows: ${report.windows.simulated ? "simulated host" : report.windows.platform}. Tray ${
      report.windows.trayAvailable ? "interface present" : "unavailable"
    }.`,
    `Knowledge: ${report.knowledge.sources} approved source(s). ${report.knowledge.detail}`,
    `Voice: ${report.voice.enabled ? `${report.voice.stt}/${report.voice.tts}` : "disabled"} (${
      report.voice.available ? "available" : "not capturing audio"
    }).`,
    ...report.context.notes,
  ];
  if (report.capability) {
    lines.push(
      `Capability profile generated ${report.capability.generatedAt}. ${report.capability.notes[0] ?? ""}`,
    );
  }
  if (report.recentErrors.length) {
    lines.push(`Recent errors: ${report.recentErrors.map((entry) => entry.message).join("; ")}`);
  } else {
    lines.push("Recent errors: none recorded.");
  }
  lines.push(
    `Classification: ${Object.entries(report.classification)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}.`,
  );
  return lines.join("\n");
}
