import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

export type Step = { name: string; args: Record<string, unknown> } | null;

/**
 * A model that is fully attacker-controlled: each completion consumes one step from a
 * shared plan. `null` means "just answer with text".
 */
export function planProvider(plan: Step[]) {
  return {
    id: "atk",
    kind: "local" as const,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "atk" };
    },
    async complete(req: CompletionRequest, model: string) {
      const step = plan.length ? plan.shift() : null;
      const toolCalls: ModelToolCall[] = step
        ? [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: step.name, arguments: step.args as never }]
        : [];
      return {
        text: step ? "" : "done",
        toolCalls,
        providerId: "atk",
        model,
        role: req.role,
      };
    },
  };
}
