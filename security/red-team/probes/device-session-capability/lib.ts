import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

/** A provider driven by an external queue so one runtime can run many attacks. */
export function queueProvider() {
  const pending: { name: string; args: Record<string, unknown> }[] = [];
  let armed = false;
  return {
    push(name: string, args: Record<string, unknown> = {}) {
      pending.push({ name, args });
      armed = true;
    },
    provider: {
      id: "atk",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "atk" };
      },
      async complete(req: CompletionRequest, model: string) {
        let toolCalls: ModelToolCall[] = [];
        if (armed && pending.length) {
          const next = pending.shift()!;
          toolCalls = [{ id: `c${Math.random()}`, name: next.name, arguments: next.args as never }];
          if (!pending.length) armed = false;
        }
        return {
          text: toolCalls.length ? "" : "done",
          toolCalls,
          providerId: "atk",
          model,
          role: req.role,
        };
      },
    },
  };
}

export function show(label: string, turn: { toolCalls: { toolName: string; decision: { allowed: boolean; reason: string }; result?: { ok: boolean; summary: string } }[] }) {
  if (!turn.toolCalls.length) {
    console.log(`${label}: NO TOOL CALLS`);
    return;
  }
  for (const c of turn.toolCalls) {
    console.log(
      `${label}: tool=${c.toolName} allowed=${c.decision.allowed} ok=${c.result?.ok} :: ${(c.result?.summary ?? c.decision.reason).slice(0, 160)}`,
    );
  }
}
