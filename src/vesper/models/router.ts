import type { VesperConfig } from "../config.ts";
import type { CompletionRequest, CompletionResult, DiscoveredModel, ModelRole } from "../types.ts";
import { pickInstalledModel } from "./backends.ts";
import { createEchoProvider } from "./echo.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createOpenAiCompatProvider, type OpenAiCompatProvider } from "./openai-compat.ts";

export interface ModelRouter {
  complete: (request: CompletionRequest) => Promise<CompletionResult>;
  resolveRole: (text: string, workspaceRole?: ModelRole) => ModelRole;
  status: () => {
    active: string;
    available: { id: string; kind: string; available: boolean }[];
  };
  setActive: (id: string) => void;
  probeAll: () => Promise<void>;
  providers: () => AnyProvider[];
}

const CODING = /\b(code|refactor|typescript|python|bug|compile|function|class|diff)\b/i;
const REASONING = /\b(why|explain|trade-?off|plan|architect|diagnos|root cause)\b/i;
const LARGE = /\b(analyze this (log|file|dump)|summarize (the )?(whole|entire)|long context)\b/i;

export function resolveRole(text: string, workspaceRole?: ModelRole): ModelRole {
  if (CODING.test(text)) return "coding";
  if (LARGE.test(text)) return "large";
  if (REASONING.test(text)) return "reasoning";
  return workspaceRole ?? "everyday";
}

export type AnyProvider = {
  id: string;
  kind: string;
  isAvailable: () => boolean;
  complete: (request: CompletionRequest, model: string) => Promise<CompletionResult>;
  probe?: () => Promise<{ available: boolean; detail: string }>;
  /** Backends that can enumerate what is installed locally. */
  listModels?: () => Promise<DiscoveredModel[]>;
  /** Backends that expose a per-model context window. */
  contextLength?: (model: string) => Promise<number | null>;
  /** Backends that can generate embeddings without a second service. */
  embed?: (texts: string[], model: string) => Promise<number[][] | null>;
  /**
   * Names from the last probe. Empty means "not yet known", not "nothing installed" —
   * the router will not substitute in that case, so a configured name still reaches
   * the wire.
   */
  installedModels?: () => string[];
  defaultModel?: string;
};

export function createModelRouter(input: {
  config: VesperConfig;
  providers?: AnyProvider[];
  xaiKey?: string;
}): ModelRouter {
  const echo = createEchoProvider();
  // Ollama is reached through its native API, not the OpenAI-compat shim: the shim
  // hides installed-model metadata, resident VRAM, and the token counters Vesper needs
  // to report throughput as a measurement rather than an estimate.
  const ollama = createOllamaProvider({
    id: "ollama",
    baseUrl: input.config.models.endpoints.ollama,
    defaultModel: input.config.models.roles.everyday?.model ?? "qwen2.5:14b",
  });
  const llamacpp = createOpenAiCompatProvider({
    id: "llamacpp",
    baseUrl: input.config.models.endpoints.llamacpp,
    defaultModel: input.config.models.roles.large?.model ?? "qwen2.5-32b-q4",
    kind: "local",
  });
  const providers: AnyProvider[] = input.providers ? [...input.providers] : [ollama, llamacpp];
  if (input.config.models.allowOptionalCloud && input.xaiKey) {
    const xai = createOpenAiCompatProvider({
      id: "xai-optional",
      baseUrl: input.config.models.endpoints.xai,
      apiKey: input.xaiKey,
      defaultModel: "grok-4.5",
      kind: "optional-cloud",
    });
    providers.push(xai);
  }
  if (!providers.some((provider) => provider.id === "echo")) providers.push(echo);

  let activeId: string | undefined;
  let lastProbeAt = 0;
  let probePromise: Promise<void> | null = null;

  /**
   * Providers were probed once, at the end of fire-and-forget first-boot discovery, and
   * never again - so the first messages after launch fell back to the offline stub even
   * with a backend running, `--skip-discovery` meant no probe ever happened, and a
   * backend started *after* Vesper was never noticed.
   *
   * Re-probing lazily, only when no local backend appears available, keeps an idle
   * assistant free of background polling while still recovering on its own.
   *
   * A probe in flight must be awaited, not treated as already done. `probeAll` used
   * to stamp `lastProbeAt` before the probes returned, so a concurrent `--ask`
   * during first-boot discovery saw "just probed" + `isAvailable() === false` and
   * fell through to echo.
   */
  const REPROBE_AFTER_MS = 15_000;

  function startProbe(): Promise<void> {
    if (!probePromise) {
      probePromise = (async () => {
        try {
          await Promise.all(
            providers.map((provider) => provider.probe?.().catch(() => undefined)),
          );
          lastProbeAt = Date.now();
        } finally {
          probePromise = null;
        }
      })();
    }
    return probePromise;
  }

  async function awaitInFlightProbe(): Promise<void> {
    if (probePromise) await probePromise;
  }

  async function reprobeIfStale(): Promise<void> {
    if (probePromise) {
      await probePromise;
      return;
    }
    if (lastProbeAt !== 0 && Date.now() - lastProbeAt < REPROBE_AFTER_MS) return;
    await startProbe();
  }

  /**
   * Configured name if it is installed (or we cannot tell). An installed chat
   * model if the config still names a candidate that was never pulled. Never
   * an embedding model, and never a rewrite of the config file.
   */
  function resolveModel(provider: AnyProvider, role: ModelRole): string {
    const wanted = modelFor(provider, role);
    if (provider.id === "echo" || provider.kind === "optional-cloud") return wanted;
    const names = provider.installedModels?.() ?? [];
    if (names.length === 0) return wanted;
    return pickInstalledModel(
      names.map((name) => ({ name, available: true })),
      wanted,
      role,
    );
  }

  async function pick(role: ModelRole): Promise<{ provider: AnyProvider; model: string }> {
    await awaitInFlightProbe();
    if (activeId) {
      const forced = providers.find((provider) => provider.id === activeId);
      if (forced) return { provider: forced, model: resolveModel(forced, role) };
    }
    const preferred = input.config.models.roles[role];
    if (preferred) {
      const match = providers.find(
        (provider) => provider.id === preferred.provider && provider.isAvailable(),
      );
      if (match) return { provider: match, model: resolveModel(match, role) };
    }
    let local = providers.find(
      (provider) => provider.kind === "local" && provider.isAvailable(),
    );
    if (!local) {
      // No local backend looks available. That may simply be stale information.
      await reprobeIfStale();
      const preferredNow = input.config.models.roles[role];
      if (preferredNow) {
        const match = providers.find(
          (provider) => provider.id === preferredNow.provider && provider.isAvailable(),
        );
        if (match) return { provider: match, model: resolveModel(match, role) };
      }
      local = providers.find(
        (provider) => provider.kind === "local" && provider.isAvailable(),
      );
    }
    if (local) {
      return { provider: local, model: resolveModel(local, role) };
    }
    const optional = providers.find(
      (provider) => provider.kind === "optional-cloud" && provider.isAvailable(),
    );
    if (optional) {
      return { provider: optional, model: resolveModel(optional, role) };
    }
    const other = providers.find(
      (provider) => provider.id !== "echo" && provider.isAvailable(),
    );
    if (other) {
      return { provider: other, model: resolveModel(other, role) };
    }
    return { provider: echo, model: "echo" };
  }

  /** Resolve the model name a given provider should be asked for at this role. */
  function modelFor(provider: AnyProvider, role: ModelRole): string {
    const configured = input.config.models.roles[role];
    if (configured && configured.provider === provider.id) return configured.model;
    if (provider.id === "xai-optional") return "grok-4.5";
    if (provider.id === "echo") return "echo";
    return provider.defaultModel ?? configured?.model ?? "default";
  }

  return {
    resolveRole,
    setActive(id: string) {
      activeId = id;
    },
    status() {
      return {
        active: activeId ?? "auto",
        available: providers.map((provider) => ({
          id: provider.id,
          kind: provider.kind,
          available: provider.isAvailable(),
        })),
      };
    },
    async probeAll() {
      if (probePromise) {
        await probePromise;
        return;
      }
      await startProbe();
    },
    providers() {
      return providers.slice();
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const selected = await pick(request.role);
      const result = await selected.provider.complete(request, selected.model);
      // A caller-cancelled turn is not a backend outage: never retry it elsewhere.
      if (result.unavailable && !result.aborted && !request.signal?.aborted) {
        const fallback = providers.find(
          (provider) => provider.id !== selected.provider.id && provider.isAvailable(),
        );
        if (fallback) {
          // Model names are provider-specific. Asking a different backend for the
          // failed backend's model name would just fail a second time.
          const retry = await fallback.complete(request, resolveModel(fallback, request.role));
          return { ...retry, error: result.error };
        }
      }
      return result;
    },
  };
}

export type { OpenAiCompatProvider };
