import type { VesperConfig } from "../config.ts";
import type { CompletionRequest, CompletionResult, ModelRole } from "../types.ts";
import { createEchoProvider } from "./echo.ts";
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
};

export function createModelRouter(input: {
  config: VesperConfig;
  providers?: AnyProvider[];
  xaiKey?: string;
}): ModelRouter {
  const echo = createEchoProvider();
  const ollama = createOpenAiCompatProvider({
    id: "ollama",
    baseUrl: input.config.models.endpoints.ollama,
    defaultModel: input.config.models.roles.everyday?.model ?? "qwen2.5:14b",
    kind: "local",
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

  async function pick(role: ModelRole): Promise<{ provider: AnyProvider; model: string }> {
    if (activeId) {
      const forced = providers.find((provider) => provider.id === activeId);
      if (forced) {
        const model =
          forced.id === "xai-optional"
            ? "grok-4.5"
            : input.config.models.roles[role]?.model ?? "default";
        return { provider: forced, model };
      }
    }
    const preferred = input.config.models.roles[role];
    if (preferred) {
      const match = providers.find(
        (provider) => provider.id === preferred.provider && provider.isAvailable(),
      );
      if (match) return { provider: match, model: preferred.model };
    }
    const local = providers.find(
      (provider) => provider.kind === "local" && provider.isAvailable(),
    );
    if (local) {
      return {
        provider: local,
        model: input.config.models.roles[role]?.model ?? "default",
      };
    }
    const optional = providers.find(
      (provider) => provider.kind === "optional-cloud" && provider.isAvailable(),
    );
    if (optional) {
      return { provider: optional, model: optional.id === "xai-optional" ? "grok-4.5" : "default" };
    }
    const other = providers.find(
      (provider) => provider.id !== "echo" && provider.isAvailable(),
    );
    if (other) {
      return {
        provider: other,
        model: input.config.models.roles[role]?.model ?? other.id,
      };
    }
    return { provider: echo, model: "echo" };
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
      await Promise.all(providers.map((provider) => provider.probe?.()));
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const selected = await pick(request.role);
      const result = await selected.provider.complete(request, selected.model);
      if (result.unavailable) {
        const fallback = providers.find(
          (provider) => provider.id !== selected.provider.id && provider.isAvailable(),
        );
        if (fallback) {
          const retry = await fallback.complete(request, selected.model);
          return { ...retry, error: result.error };
        }
      }
      return result;
    },
  };
}

export type { OpenAiCompatProvider };
