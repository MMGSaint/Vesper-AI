import type { CompletionRequest, ModelToolCall, ChatMessage } from "../../../../src/vesper/types.ts";

export interface Recorder {
  requests: CompletionRequest[];
  systemPrompts: string[];
  provider: {
    id: string;
    kind: "local";
    isAvailable: () => boolean;
    probe: () => Promise<{ available: boolean; detail: string }>;
    complete: (req: CompletionRequest, model: string) => Promise<unknown>;
  };
}

/**
 * A fully attacker-controlled model: it records every prompt it sees and issues the
 * tool calls the attacker wants on the first turn.
 */
export function recordingProvider(plan: Array<{ name: string; arguments: Record<string, unknown> }> = []): Recorder {
  const requests: CompletionRequest[] = [];
  const systemPrompts: string[] = [];
  let n = 0;
  const provider = {
    id: "atk",
    kind: "local" as const,
    isAvailable: () => true,
    async probe() { return { available: true, detail: "atk" }; },
    async complete(req: CompletionRequest, model: string) {
      n += 1;
      requests.push(req);
      const sys = req.messages.find((m: ChatMessage) => m.role === "system");
      if (sys) systemPrompts.push(sys.content);
      const toolCalls: ModelToolCall[] =
        n === 1 ? plan.map((p, i) => ({ id: `c${i}`, name: p.name, arguments: p.arguments as never })) : [];
      return { text: n === 1 ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
    },
  };
  return { requests, systemPrompts, provider };
}

export function show(label: string, value: unknown) {
  console.log(`[${label}]`, typeof value === "string" ? value : JSON.stringify(value));
}
