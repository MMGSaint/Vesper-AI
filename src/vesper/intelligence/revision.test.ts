import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviseMemory } from "./revision.ts";
import type { MemoryEntry } from "../types.ts";

function fact(
  value: string,
  kind: "stated" | "observed" | "inferred",
  at: string,
): Pick<MemoryEntry, "key" | "value" | "provenance" | "updatedAt" | "category" | "tags"> {
  return {
    key: "editor",
    value,
    category: "preference",
    provenance: { origin: kind === "stated" ? "user" : "agent", kind },
    updatedAt: at,
  };
}

describe("memory revision", () => {
  it("rejects an inferred overwrite of a stated preference", () => {
    const decision = reviseMemory(
      fact("vim", "stated", "2026-09-01T00:00:00.000Z"),
      fact("emacs", "inferred", "2026-09-02T00:00:00.000Z"),
    );
    assert.equal(decision.action, "reject");
  });

  it("lets a newer stated preference supersede the old one", () => {
    const decision = reviseMemory(
      fact("vim", "stated", "2026-09-01T00:00:00.000Z"),
      fact("helix", "stated", "2026-09-03T00:00:00.000Z"),
    );
    assert.equal(decision.action, "supersede");
  });

  it("disputes equal provenance at the same time", () => {
    const decision = reviseMemory(
      fact("vim", "stated", "2026-09-01T00:00:00.000Z"),
      fact("emacs", "stated", "2026-09-01T00:00:00.000Z"),
    );
    assert.equal(decision.action, "dispute");
  });

  it("does not treat an identical value as a contradiction", () => {
    const decision = reviseMemory(
      fact("vim", "stated", "2026-09-01T00:00:00.000Z"),
      fact("vim", "inferred", "2026-09-02T00:00:00.000Z"),
    );
    assert.equal(decision.action, "keep");
  });
});
