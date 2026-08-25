import type { CompletionRequest, CompletionResult, ModelProviderInfo } from "../types.ts";

export function createEchoProvider(): ModelProviderInfo & {
  complete: (request: CompletionRequest, model: string) => Promise<CompletionResult>;
  isAvailable: () => boolean;
  probe: () => Promise<{ available: boolean; detail: string }>;
} {
  return {
    id: "echo",
    kind: "test",
    available: true,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "Echo provider (tests / degraded mode)" };
    },
    async complete(request: CompletionRequest, model: string): Promise<CompletionResult> {
      const last = [...request.messages].reverse().find((message) => message.role === "user");
      const text = last?.content ?? "";
      return {
        text: `I heard you, but no local inference backend is available. I can still use tools, memory, and the simulated host. You said: "${text.slice(0, 240)}"`,
        toolCalls: [],
        providerId: "echo",
        model,
        role: request.role,
      };
    },
  };
}
