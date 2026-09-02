import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleContext, renderAssembled } from "./assembly.ts";
import type { MemoryEntry } from "../types.ts";
import type { Instinct } from "./instincts.ts";

function mem(partial: Partial<MemoryEntry> & { key: string; value: string }): MemoryEntry {
  return {
    id: "m",
    category: "fact",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    source: "user",
    scope: "user",
    revision: 1,
    provenance: { origin: "user", kind: "stated" },
    ...partial,
  };
}

describe("context assembly", () => {
  it("keeps the smallest useful set and labels instincts as not policy", () => {
    const instinct: Instinct = {
      id: "i1",
      situation: "gaming",
      action: "use fast model",
      confidence: 0.6,
      evidence: [],
      state: "candidate",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const ctx = assembleContext({
      query: "favourite colour for gaming",
      memories: [
        mem({ key: "favourite-colour", value: "blue", category: "preference" }),
        mem({ key: "api_key", value: "sk-live", category: "config" }),
        mem({ key: "tmp", value: "scratch", category: "session", scope: "session" }),
      ],
      instincts: [instinct],
    });
    assert.ok(ctx.facts.some((fact) => fact.key === "favourite-colour"));
    assert.ok(ctx.facts.every((fact) => fact.key !== "api_key"));
    assert.equal(ctx.instincts[0]?.policy, false);
    assert.match(renderAssembled(ctx), /not policy/);
  });
});
