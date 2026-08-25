import { cpus, hostname, totalmem, freemem, arch, platform, type } from "node:os";
import type { VesperConfig } from "../config.ts";
import type { CapabilityProfile, HardwareSnapshot } from "../types.ts";
import { probeOpenAiCompatible } from "../models/openai-compat.ts";

export function discoverCurrentMachine() {
  const cpuList = cpus();
  return {
    os: `${type()} (${platform()})`,
    arch: arch(),
    cpuModel: cpuList[0]?.model,
    ramGB: Math.round(totalmem() / 1024 / 1024 / 1024),
    hostname: hostname(),
    cpuCount: cpuList.length,
    ramUsedGB: Math.round((totalmem() - freemem()) / 1024 / 1024 / 1024),
  };
}

export function liveHardwareSnapshot(): HardwareSnapshot {
  const machine = discoverCurrentMachine();
  const cpuList = cpus();
  const idle = cpuList.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const total = cpuList.reduce(
    (sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq,
    0,
  );
  const utilizationPct = total === 0 ? 0 : Math.round((1 - idle / total) * 100);
  return {
    mode: "live",
    os: machine.os,
    hostname: machine.hostname,
    cpu: {
      name: machine.cpuModel ?? "Unknown CPU",
      cores: Math.max(1, Math.round(cpuList.length / 2)),
      threads: cpuList.length,
      utilizationPct,
      tempC: null,
    },
    gpu: null,
    ram: { totalGB: machine.ramGB ?? 0, usedGB: machine.ramUsedGB ?? 0 },
    notes: [
      "Live snapshot of the current process host, not the target gaming PC.",
      "CPU temperatures, GPU telemetry, clocks, and AMD-specific sensors were not read.",
    ],
    capturedAt: new Date().toISOString(),
  };
}

export async function discoverCapabilityProfile(config: VesperConfig): Promise<CapabilityProfile> {
  const current = discoverCurrentMachine();
  const [ollama, llamacpp] = await Promise.all([
    probeOpenAiCompatible(config.models.endpoints.ollama),
    probeOpenAiCompatible(config.models.endpoints.llamacpp),
  ]);
  const xaiKey = Boolean(process.env.XAI_API_KEY);

  return {
    generatedAt: new Date().toISOString(),
    currentMachine: current,
    targetProfile: config.hardware.target,
    backends: [
      {
        id: "ollama",
        available: ollama.available,
        endpoint: config.models.endpoints.ollama,
        detail: ollama.detail,
        status: ollama.available ? "implemented_hardware_dependent" : "implemented_tested",
      },
      {
        id: "llamacpp",
        available: llamacpp.available,
        endpoint: config.models.endpoints.llamacpp,
        detail: llamacpp.detail,
        status: llamacpp.available ? "implemented_hardware_dependent" : "implemented_tested",
      },
      {
        id: "llamacpp-vulkan",
        available: false,
        detail: "Vulkan backend is the preferred AMD RDNA3 path; requires the target PC.",
        status: "implemented_hardware_dependent",
      },
      {
        id: "llamacpp-rocm",
        available: false,
        detail: "ROCm/HIP is a secondary AMD path; not probed on this host.",
        status: "implemented_hardware_dependent",
      },
      {
        id: "xai-optional",
        available: xaiKey,
        endpoint: config.models.endpoints.xai,
        detail: xaiKey
          ? "Optional cloud provider available in this environment. Not a production dependency."
          : "No optional cloud key present.",
        status: "implemented_tested",
      },
    ],
    models: [],
    telemetry: "mocked_simulated",
    audio: "documented_not_implemented",
    windowsIntegration: platform() === "win32" ? "implemented_hardware_dependent" : "mocked_simulated",
    optimizer: config.optimizer.mode === "live" ? "implemented_hardware_dependent" : "mocked_simulated",
    voice: "documented_not_implemented",
    notes: [
      "No physical validation of the Ryzen 9 9950X / RX 7900 XT machine was performed.",
      "Default model picks are conservative candidates, not benchmark winners.",
      "First-boot on the target PC should probe Ollama, llama.cpp Vulkan, and ROCm, then configure roles from discovered models.",
    ],
  };
}
