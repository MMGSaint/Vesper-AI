import { spawn } from "node:child_process";
import type { BackendAvailability, DiscoveredModel, FeatureStatus, ModelRole } from "../types.ts";
import { listOpenAiModels } from "./openai-compat.ts";

export type WhichFn = (name: string) => Promise<boolean>;
export type ListModelsFn = typeof listOpenAiModels;

const ROLE_HINTS: { pattern: RegExp; role: ModelRole }[] = [
  { pattern: /coder|code/i, role: "coding" },
  { pattern: /32b|70b|large/i, role: "large" },
  { pattern: /3b|mini|fast/i, role: "fast" },
  { pattern: /14b|7b|8b/i, role: "everyday" },
];

export function hintRole(name: string): ModelRole | undefined {
  return ROLE_HINTS.find((entry) => entry.pattern.test(name))?.role;
}

const EMBED_MODEL = /embed|nomic-embed|bge-|minilm|e5-/i;

export function isChatModel(name: string): boolean {
  return !EMBED_MODEL.test(name);
}

/** Ollama treats a missing tag as `:latest`; a listed `:latest` matches the untagged name. */
export function modelNamesMatch(installed: string, wanted: string): boolean {
  const strip = (name: string) => name.replace(/:latest$/i, "");
  return installed === wanted || strip(installed) === strip(wanted);
}

/**
 * Pick a model to ask a local backend for.
 *
 * The configured name wins when it is installed. Substituting is only for the
 * first-boot case where the config still names a candidate that was never pulled.
 * Embedding-only names are never used for chat. The config file is not rewritten.
 */
export function pickInstalledModel(
  installed: readonly { name: string; available?: boolean; roleHint?: ModelRole }[],
  wanted: string,
  role: ModelRole,
): string {
  const chat = installed.filter((entry) => entry.available !== false && isChatModel(entry.name));
  if (chat.length === 0) return wanted;
  if (chat.some((entry) => modelNamesMatch(entry.name, wanted))) return wanted;
  const hinted = chat.find((entry) => (entry.roleHint ?? hintRole(entry.name)) === role);
  if (hinted) return hinted.name;
  const everyday = chat.find((entry) => (entry.roleHint ?? hintRole(entry.name)) === "everyday");
  if (everyday) return everyday.name;
  return chat[0].name;
}

export async function commandExists(
  name: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  const cmd = platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(cmd, [name], { shell: false, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 800);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export interface BackendDiscoveryInput {
  endpoints: { ollama: string; llamacpp: string; xai: string };
  allowOptionalCloud?: boolean;
  xaiKeyPresent?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  which?: WhichFn;
  listModels?: ListModelsFn;
}

export interface BackendDiscovery {
  backends: BackendAvailability[];
  models: DiscoveredModel[];
  preferredBackend: string | null;
}

export async function discoverInferenceBackends(input: BackendDiscoveryInput): Promise<BackendDiscovery> {
  const listModels = input.listModels ?? listOpenAiModels;
  const which = input.which ?? ((name: string) => commandExists(name, input.platform));
  const env = input.env ?? process.env;
  const llamaBackend = (env.VESPER_LLAMA_BACKEND ?? "").toLowerCase();

  const [ollamaBin, llamaBin, ollama, llamacpp] = await Promise.all([
    which("ollama"),
    which("llama-server").then(async (found) => found || which("llama-cli")),
    listModels(input.endpoints.ollama, 800),
    listModels(input.endpoints.llamacpp, 800),
  ]);

  const vulkanRequested = llamaBackend === "vulkan" || llamaBackend === "";
  const rocmRequested = llamaBackend === "rocm" || llamaBackend === "hip";

  const backends: BackendAvailability[] = [
    {
      id: "ollama",
      available: ollama.available,
      endpoint: input.endpoints.ollama,
      detail: ollama.available
        ? ollama.detail
        : ollamaBin
          ? `Ollama binary present but API unreachable: ${ollama.detail}`
          : ollama.detail,
      status: ollama.available ? "implemented_hardware_dependent" : "implemented_tested",
    },
    {
      id: "llamacpp",
      available: llamacpp.available,
      endpoint: input.endpoints.llamacpp,
      detail: llamacpp.available
        ? llamacpp.detail
        : llamaBin
          ? `llama.cpp binary present but API unreachable: ${llamacpp.detail}`
          : llamacpp.detail,
      status: llamacpp.available ? "implemented_hardware_dependent" : "implemented_tested",
    },
    {
      id: "llamacpp-vulkan",
      available: llamacpp.available && vulkanRequested,
      endpoint: input.endpoints.llamacpp,
      detail: llamacpp.available
        ? vulkanRequested
          ? "llama.cpp endpoint is up. Vulkan is the preferred RDNA3 path; this host did not prove the backend is Vulkan."
          : "llama.cpp is up but VESPER_LLAMA_BACKEND is not vulkan."
        : "Vulkan llama.cpp was not reachable. Preferred AMD RDNA3 path when the target PC is on.",
      status: "implemented_hardware_dependent",
    },
    {
      id: "llamacpp-rocm",
      available: llamacpp.available && rocmRequested,
      endpoint: input.endpoints.llamacpp,
      detail: rocmRequested
        ? llamacpp.available
          ? "ROCm/HIP requested via VESPER_LLAMA_BACKEND. Not assumed faster than Vulkan."
          : "ROCm/HIP requested but llama.cpp was unreachable."
        : "ROCm/HIP is a secondary AMD path. Not probed unless VESPER_LLAMA_BACKEND=rocm.",
      status: "implemented_hardware_dependent",
    },
    {
      id: "cpu-offload",
      available: false,
      detail:
        "CPU offload is a fallback for models that exceed 20 GB VRAM. Not selected automatically without a local benchmark.",
      status: "documented_not_implemented",
    },
    {
      id: "xai-optional",
      available: Boolean(input.allowOptionalCloud && input.xaiKeyPresent),
      endpoint: input.endpoints.xai,
      detail:
        input.allowOptionalCloud && input.xaiKeyPresent
          ? "Optional cloud provider available in this environment. Not a production dependency."
          : "No optional cloud key present.",
      status: "implemented_tested",
    },
  ];

  const models: DiscoveredModel[] = [
    ...ollama.models.map((name) => ({
      provider: "ollama",
      name,
      roleHint: hintRole(name),
      available: true,
    })),
    ...llamacpp.models.map((name) => ({
      provider: "llamacpp",
      name,
      roleHint: hintRole(name),
      available: true,
    })),
  ];

  const preferred =
    backends.find((backend) => backend.id === "ollama" && backend.available)?.id ??
    backends.find((backend) => backend.id === "llamacpp-vulkan" && backend.available)?.id ??
    backends.find((backend) => backend.id === "llamacpp" && backend.available)?.id ??
    null;

  return { backends, models, preferredBackend: preferred };
}

export function classifyBackendStatus(available: boolean): FeatureStatus {
  return available ? "implemented_hardware_dependent" : "implemented_tested";
}
