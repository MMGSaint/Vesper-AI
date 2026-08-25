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

export interface FirstBootOptions {
  storage?: StorageAdapter;
  reportPath?: string;
  selfCheck?: () => Promise<{ ok: boolean; detail: string }>;
  now?: () => Date;
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
    step(
      "gpu",
      "Detect GPU",
      false,
      "Live GPU identity was not read. Target GPU is AMD Radeon RX 7900 XT (20 GB).",
      "implemented_hardware_dependent",
    ),
  );
  steps.push(
    step(
      "vram",
      "Detect VRAM",
      false,
      "Live VRAM was not read. Target VRAM is 20 GB.",
      "implemented_hardware_dependent",
    ),
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
    step(
      "audio",
      "Inspect audio devices",
      false,
      "Audio device enumeration is hardware-dependent and was not opened.",
      "documented_not_implemented",
    ),
  );
  const onWindows = platform() === "win32";
  steps.push(
    step(
      "windows",
      "Inspect Windows capabilities",
      true,
      onWindows
        ? "Host reports win32. Tray/startup/toast still require first-PC validation."
        : `Host is ${platform()}. Windows tray, startup, and toasts are simulated.`,
      onWindows ? "implemented_hardware_dependent" : "mocked_simulated",
    ),
  );
  steps.push(
    step(
      "telemetry",
      "Inspect telemetry capabilities",
      false,
      "AMD ADLX/ADL telemetry, clocks, and power were not read.",
      "mocked_simulated",
    ),
  );
  steps.push(
    step(
      "optimizer",
      "Detect optimizer",
      true,
      config.optimizer.mode === "live" && config.optimizer.endpoint
        ? `Live optimizer endpoint configured: ${config.optimizer.endpoint}`
        : "Optimizer adapter is mock. The specialist API is not connected.",
      config.optimizer.mode === "live" ? "implemented_hardware_dependent" : "mocked_simulated",
    ),
  );

  const preferredBackend =
    profile.backends.find((backend) => backend.id === "ollama" && backend.available)?.id ??
    profile.backends.find((backend) => backend.id === "llamacpp" && backend.available)?.id ??
    null;
  const defaults = {
    hardwareMode: config.hardware.mode,
    optimizerMode: config.optimizer.mode,
    voiceEnabled: false,
    preferredBackend,
  };
  steps.push(
    step(
      "defaults",
      "Choose safe defaults",
      true,
      `hardware=${defaults.hardwareMode}; optimizer=${defaults.optimizerMode}; voice=off; backend=${preferredBackend ?? "echo/tools"}. No model was auto-crowned fastest.`,
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
    models: [],
    telemetry: "mocked_simulated",
    audio: "documented_not_implemented",
    windowsIntegration: "mocked_simulated",
    optimizer: "mocked_simulated",
    voice: "documented_not_implemented",
    notes: ["First-boot discovery failed; using an empty capability profile."],
  };
}
