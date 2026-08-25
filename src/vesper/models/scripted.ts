import type { CompletionRequest, CompletionResult, ModelToolCall } from "../types.ts";

export interface ScriptedTurn {
  match?: RegExp | string;
  text?: string;
  toolCalls?: ModelToolCall[];
}

export function createScriptedProvider(turns: ScriptedTurn[]) {
  let index = 0;
  return {
    id: "scripted",
    kind: "test" as const,
    available: true,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "Scripted test provider" };
    },
    async complete(request: CompletionRequest, model: string): Promise<CompletionResult> {
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      if (hasToolResult) {
        const follow = turns.find((turn) => !turn.toolCalls?.length);
        return {
          text: follow?.text ?? "I finished the requested tool calls.",
          toolCalls: [],
          providerId: "scripted",
          model,
          role: request.role,
        };
      }
      const last = [...request.messages].reverse().find((message) => message.role === "user");
      const text = last?.content ?? "";
      const byMatch = turns.find((turn) =>
        typeof turn.match === "string" ? text.includes(turn.match) : turn.match ? turn.match.test(text) : false,
      );
      const turn = byMatch ?? turns[Math.min(index, turns.length - 1)];
      if (!byMatch) index += 1;
      return {
        text: turn?.text ?? "",
        toolCalls: turn?.toolCalls ?? [],
        providerId: "scripted",
        model,
        role: request.role,
      };
    },
  };
}
