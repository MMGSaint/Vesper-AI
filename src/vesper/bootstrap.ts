import { discoverCapabilityProfile, discoverCurrentMachine } from "./hardware/discover.ts";
import type { VesperConfig } from "./config.ts";
import type { CapabilityProfile } from "./types.ts";
import type { Logger } from "./logging.ts";

export async function firstBoot(config: VesperConfig, log: Logger): Promise<CapabilityProfile> {
  log.info("lifecycle", "First-boot capability discovery started");
  const profile = await discoverCapabilityProfile(config);
  const current = discoverCurrentMachine();
  log.info("lifecycle", "First-boot discovery finished", {
    os: current.os,
    arch: current.arch,
    backends: profile.backends.map((backend) => `${backend.id}:${backend.available}`).join(","),
  });
  return profile;
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
