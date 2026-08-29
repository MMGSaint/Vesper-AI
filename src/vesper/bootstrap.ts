import { platform } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discoverCapabilityProfile, discoverCurrentMachine } from "./hardware/discover.ts";
import { evaluatePermission } from "./permissions.ts";
import { MemoryStore } from "./memory/store.ts";
import { MemoryStorage, type StorageAdapter } from "./storage.ts";
import type { VesperConfig } from "./config.ts";
import type {
  CapabilityProfile,
  FeatureStatus,
  FirstBootReport,
  FirstBootStep,
  JsonObject,
} from "./types.ts";
import type { Logger } from "./logging.ts";
import { isolateFailure } from "./recover.ts";
import type { HardwareProbeRegistry } from "./hardware/probes.ts";

export interface FirstBootOptions {
  storage?: StorageAdapter;
  reportPath?: string;
  selfCheck?: () => Promise<{ ok: boolean; detail: string }>;
  now?: () => Date;
  /**
   * Probes for the six steps that need real hardware.
   *
   * Optional so an embedder without one still gets a report, but the runtime always
   * supplies it. Before this, the registry existed, was tested, and nothing imported
   * it — the six steps were hard-coded strings, so registering a real Windows probe
   * changed nothing a user would see. That is "implemented and tested, not wired",
   * which is not a capability the product has.
   */
  probes?: HardwareProbeRegistry;
}

/**
 * Step id -> probe id.
 *
 * The two vocabularies differ and the probe module's own comment claimed they matched:
 * steps are `gpu`, `vram`, `telemetry`, `audio`, `windows`, `benchmark`, while probes
 * are `gpu.live`, `vram.live`, `telemetry.amd`, `audio.wasapi`, `windows.tray`,
 * `benchmark.harness`. A direct lookup returns undefined for all six and silently falls
 * back to the hard-coded text — the failure would have looked exactly like success.
 * One table, stated once.
 */
const PROBE_FOR_STEP: Readonly<Record<string, string>> = {
  gpu: "gpu.live",
  vram: "vram.live",
  telemetry: "telemetry.amd",
  audio: "audio.wasapi",
  windows: "windows.tray",
  benchmark: "benchmark.harness",
};

/**
 * Build a step from a probe result, or from the caller's fallback when no probe
 * answered.
 *
 * The probe's answer wins whenever one was produced, including a negative one: "the
 * probe ran and could not read the GPU" is a different fact from "no probe exists", and
 * flattening them is how a machine with a broken driver would look identical to a
 * machine that was never asked.
 */
async function probedStep(
  probes: HardwareProbeRegistry | undefined,
  id: string,
  title: string,
  fallback: { ok: boolean; detail: string; status: FeatureStatus },
  log: Logger,
): Promise<FirstBootStep> {
  const probeId = PROBE_FOR_STEP[id];
  if (!probes || !probeId || !probes.known().includes(probeId)) {
    return step(id, title, fallback.ok, fallback.detail, fallback.status);
  }
  const result = await probes.run(probeId, { platform: platform(), log: probeLogger(log) });
  return step(id, title, result.ok, result.detail, result.classification);
}

/** Adapt Vesper's logger to the minimal shape a portable probe expects. */
function probeLogger(log: Logger) {
  return {
    debug: (message: string) => log.debug("lifecycle", message),
    info: (message: string) => log.info("lifecycle", message),
    warn: (message: string) => log.warn("lifecycle", message),
    error: (message: string) => log.error("lifecycle", message),
  };
}

export async function firstBoot(config: VesperConfig, log: Logger): Promise<CapabilityProfile> {
  const report = await runFirstBootAutomation(config, log);
  return report.profile;
}

export async function runFirstBootAutomation(
  config: VesperConfig,
  log: Logger,
  options: FirstBootOptions = {},
): Promise<FirstBootReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  log.info("lifecycle", "First-boot capability discovery started");
  const steps: FirstBootStep[] = [];

  const current = discoverCurrentMachine();
  steps.push(step("os", "Detect OS", true, current.os, "implemented_tested"));
  steps.push(
    step(
      "cpu",
      "Detect CPU",
      Boolean(current.cpuModel),
      current.cpuModel ?? "CPU model unavailable",
      "implemented_tested",
    ),
  );
  steps.push(
    await probedStep(options.probes, "gpu", "Detect GPU", {
      ok: false,
      detail: "Live GPU identity was not read. Target GPU is AMD Radeon RX 7900 XT (20 GB).",
      status: "implemented_hardware_dependent",
    }, log),
  );
  steps.push(
    await probedStep(options.probes, "vram", "Detect VRAM", {
      ok: false,
      detail: "Live VRAM was not read. Target VRAM is 20 GB.",
      status: "implemented_hardware_dependent",
    }, log),
  );
  steps.push(
    step(
      "ram",
      "Detect RAM",
      current.ramGB != null,
      `${current.ramGB ?? "?"} GB on this host (target 96 GB).`,
      "implemented_tested",
    ),
  );

  const profile = await isolateFailure(
    () => discoverCapabilityProfile(config),
    emptyProfile(config, current),
    (error) =>
      log.error("lifecycle", "Capability discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  );

  const localBackends = profile.backends.filter(
    (backend) => backend.available && backend.id !== "xai-optional",
  );
  steps.push(
    step(
      "backends",
      "Detect inference backends",
      true,
      profile.backends.map((backend) => `${backend.id}:${backend.available ? "up" : "down"}`).join(", "),
      localBackends.length ? "implemented_hardware_dependent" : "implemented_tested",
    ),
  );
  steps.push(
    step(
      "models",
      "Discover local models",
      true,
      profile.models.length
        ? profile.models.map((model) => `${model.provider}/${model.name}`).join(", ")
        : "No local models were listed. Endpoints were empty or unreachable.",
      profile.models.length ? "implemented_hardware_dependent" : "implemented_tested",
    ),
  );
  steps.push(
    await probedStep(options.probes, "audio", "Inspect audio devices", {
      ok: false,
      detail: "Audio device enumeration is hardware-dependent and was not opened.",
      status: "documented_not_implemented",
    }, log),
  );
  const onWindows = platform() === "win32";
  steps.push(
    await probedStep(options.probes, "windows", "Inspect Windows capabilities", {
      ok: true,
      detail: onWindows
        ? "Host reports win32. Tray/startup/toast still require first-PC validation."
        : `Host is ${platform()}. Windows tray, startup, and toasts are simulated.`,
      status: onWindows ? "implemented_hardware_dependent" : "mocked_simulated",
    }, log),
  );
  steps.push(
    await probedStep(options.probes, "telemetry", "Inspect telemetry capabilities", {
      ok: false,
      detail: "AMD ADLX/ADL telemetry, clocks, and power were not read.",
      status: "mocked_simulated",
    }, log),
  );
  // Both halves must agree. The classification used to test `mode === "live"` alone
  // while the detail text also required an endpoint, so `mode: "live"` with no endpoint
  // printed "Optimizer adapter is mock" and classified itself
  // implemented_hardware_dependent — the report contradicting itself on one line. The
  // runtime requires both before it builds a live adapter, so the report should too.
  const optimizerLive = config.optimizer.mode === "live" && Boolean(config.optimizer.endpoint);
  steps.push(
    step(
      "optimizer",
      "Detect optimizer",
      true,
      optimizerLive
        ? `Live optimizer endpoint configured: ${config.optimizer.endpoint}`
        : config.optimizer.mode === "live"
          ? "Optimizer mode is 'live' but no endpoint is configured, so the adapter is still a mock."
          : "Optimizer adapter is mock. The specialist API is not connected.",
      optimizerLive ? "implemented_hardware_dependent" : "mocked_simulated",
    ),
  );

  steps.push(
    step(
      "runtime-deps",
      "Inspect runtime dependencies",
      true,
      `Node ${process.versions.node}. TypeScript host can run without a local LLM.`,
      "implemented_tested",
    ),
  );
  steps.push(
    step(
      "applications",
      "Inspect approved application catalog",
      true,
      `${config.approvedApps.length} approved apps. Live detection waits for the Windows host.`,
      "implemented_tested",
    ),
  );
  steps.push(
    await probedStep(options.probes, "benchmark", "Model benchmark harness", {
      ok: true,
      detail:
        "Harness is installed. It refuses to invent TTFT/throughput unless a local backend actually generates tokens. Not run automatically because this host has no proven local model.",
      status: "documented_not_implemented",
    }, log),
  );

  // Use the profile's own answer rather than re-deriving one here. The local version
  // knew about `ollama` and `llamacpp` only, so on a Vulkan-only host discovery said
  // "llamacpp-vulkan" and this report said "llamacpp" — two answers to one question,
  // for the backend CLAUDE.md names as the preferred AMD RDNA3 path.
  const preferredBackend = profile.preferredBackend ?? null;
  const defaults = {
    hardwareMode: config.hardware.mode,
    optimizerMode: config.optimizer.mode,
    // Read from config rather than hard-coded false. A user with voice enabled was
    // still told "voice=off" by their own first-boot report.
    voiceEnabled: config.voice.enabled,
    preferredBackend,
  };
  // `hardware.mode` is recorded everywhere and branched on nowhere: the runtime builds
  // a simulated hardware source unconditionally, so setting "live" changes no
  // behaviour. Until a live source exists, saying so is the whole of the honest answer
  // — a user who set "live" is otherwise entitled to believe it took effect.
  steps.push(
    step(
      "hardware-mode",
      "Hardware source",
      true,
      config.hardware.mode === "live"
        ? "hardware.mode is 'live', but no live hardware source is implemented yet — readings are still simulated. This setting will take effect on the target PC."
        : `hardware.mode is '${config.hardware.mode}'; readings are simulated.`,
      config.hardware.mode === "live" ? "documented_not_implemented" : "mocked_simulated",
    ),
  );
  steps.push(
    step(
      "defaults",
      "Choose safe defaults",
      true,
      `hardware=${defaults.hardwareMode}; optimizer=${defaults.optimizerMode}; voice=${defaults.voiceEnabled ? "on" : "off"}; backend=${preferredBackend ?? "echo/tools"}. No model was auto-crowned fastest.`,
      "implemented_tested",
    ),
  );

  const check = options.selfCheck
    ? await isolateFailure(options.selfCheck, { ok: false, detail: "Self-check threw." })
    : await defaultSelfCheck();
  steps.push(
    step(
      "self-check",
      "Test assistant runtime",
      check.ok,
      check.detail,
      check.ok ? "implemented_tested" : "implemented_tested",
    ),
  );

  let persisted = false;
  if (options.storage) {
    try {
      await options.storage.set("capability.profile", profile as unknown as JsonObject);
      await options.storage.set("first-boot.defaults", defaults);
      persisted = true;
    } catch (error) {
      log.warn("lifecycle", "Could not persist first-boot profile", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  steps.push(
    step(
      "persist",
      "Persist configuration",
      persisted || !options.storage,
      persisted
        ? "Capability profile stored locally."
        : options.storage
          ? "Persist failed; assistant continues with in-memory profile."
          : "No storage adapter provided; profile kept in memory.",
      "implemented_tested",
    ),
  );

  const finishedAt = now().toISOString();
  const reportText = formatFirstBootReport({ startedAt, finishedAt, steps, profile, defaults, persisted });
  if (options.reportPath) {
    try {
      await mkdir(dirname(options.reportPath), { recursive: true });
      await writeFile(options.reportPath, reportText, "utf8");
    } catch (error) {
      log.warn("lifecycle", "Could not write first-boot report file", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  steps.push(
    step("report", "Produce diagnostics report", true, "Human-readable first-boot report generated.", "implemented_tested"),
  );

  log.info("lifecycle", "First-boot discovery finished", {
    os: current.os,
    arch: current.arch,
    backends: profile.backends.map((backend) => `${backend.id}:${backend.available}`).join(","),
    persisted,
  });

  return {
    startedAt,
    finishedAt,
    steps,
    profile,
    defaults,
    reportText,
    persisted,
  };
}

export function conservativeModelPlan(profile: CapabilityProfile): string[] {
  const notes = [
    "No model was auto-selected as 'fastest' because the target PC has not been benchmarked.",
    "When the Ryzen 9 9950X + RX 7900 XT machine is available, Vesper should:",
    "1. Discover CPU, GPU, VRAM, RAM, OS.",
    "2. Probe Ollama, llama.cpp Vulkan, and llama.cpp ROCm/HIP.",
    "3. List installed models.",
    "4. Run a local benchmark harness (not yet executed).",
    "5. Assign roles: fast, everyday, reasoning, coding, large.",
    "6. Prefer Vulkan on RDNA3 unless a real benchmark says otherwise.",
    "7. Fall back to CPU offload for models that exceed 20 GB VRAM.",
  ];
  const local = profile.backends.filter((backend) => backend.available && backend.id !== "xai-optional");
  if (local.length === 0) {
    notes.push("No local inference backend is reachable on this host.");
  }
  return notes;
}

function step(
  id: string,
  title: string,
  ok: boolean,
  detail: string,
  status: FeatureStatus,
): FirstBootStep {
  return { id, title, ok, detail, status };
}

function formatFirstBootReport(input: {
  startedAt: string;
  finishedAt: string;
  steps: FirstBootStep[];
  profile: CapabilityProfile;
  defaults: FirstBootReport["defaults"];
  persisted: boolean;
}): string {
  const lines = [
    "Vesper first-boot report",
    `Started: ${input.startedAt}`,
    `Finished: ${input.finishedAt}`,
    "",
    "Steps:",
    ...input.steps.map(
      (item) => `- [${item.ok ? "ok" : "fail"}] ${item.title}: ${item.detail} (${item.status})`,
    ),
    "",
    `Safe defaults: backend=${input.defaults.preferredBackend ?? "echo/tools"}, optimizer=${input.defaults.optimizerMode}, voice=${input.defaults.voiceEnabled ? "on" : "off"}.`,
    `Persisted: ${input.persisted ? "yes" : "no"}`,
    "",
    ...input.profile.notes,
  ];
  return lines.join("\n");
}

async function defaultSelfCheck(): Promise<{ ok: boolean; detail: string }> {
  const memory = new MemoryStore(new MemoryStorage());
  await memory.remember({ category: "session", key: "self-check", value: "ok", source: "system" });
  const hit = await memory.retrieve("self-check");
  const denied = evaluatePermission({
    tool: {
      name: "disk_wipe",
      description: "never",
      permission: "never",
      parameters: { type: "object", properties: {} },
    },
    args: {},
    policy: { toolOverrides: {}, neverAllowAutonomous: ["disk_wipe"] },
    workspaceId: "general",
  });
  if (!hit || denied.allowed) return { ok: false, detail: "Self-check failed." };
  return { ok: true, detail: "Memory write/read and never-permission gate passed." };
}

function emptyProfile(
  config: VesperConfig,
  current: ReturnType<typeof discoverCurrentMachine>,
): CapabilityProfile {
  return {
    generatedAt: new Date().toISOString(),
    currentMachine: current,
    targetProfile: config.hardware.target,
    backends: [],
    preferredBackend: null,
    models: [],
    telemetry: "mocked_simulated",
    audio: "documented_not_implemented",
    windowsIntegration: "mocked_simulated",
    optimizer: "mocked_simulated",
    voice: "documented_not_implemented",
    notes: ["First-boot discovery failed; using an empty capability profile."],
  };
}
