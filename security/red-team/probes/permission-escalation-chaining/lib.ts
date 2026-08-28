import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

/** A scripted provider that emits a fixed SEQUENCE of tool-call batches, one per model turn. */
export function scriptSequence(batches: { name: string; arguments: Record<string, unknown> }[][]) {
  let n = 0;
  return {
    id: "atk",
    kind: "local" as const,
    available: true,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "atk" };
    },
    async complete(req: CompletionRequest, model: string) {
      const batch = batches[n];
      n += 1;
      const toolCalls: ModelToolCall[] = batch
        ? batch.map((c, i) => ({ id: `c${n}_${i}`, name: c.name, arguments: c.arguments as never }))
        : [];
      return {
        text: batch ? "" : "done",
        toolCalls,
        providerId: "atk",
        model,
        role: req.role,
      };
    },
  };
}

export function callsTool(name: string, args: Record<string, unknown>) {
  return scriptSequence([[{ name, arguments: args }]]);
}
