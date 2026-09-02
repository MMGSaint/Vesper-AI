import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testRuntime } from "./test-helpers.ts";
import { MemoryStorage } from "./storage.ts";
import { InstinctStore } from "./intelligence/instincts.ts";
import { buildTaskPacket, validateReturnedArtifact } from "./intelligence/packet.ts";
import { planExecution } from "./intelligence/route.ts";
import { reviseMemory } from "./intelligence/revision.ts";
import type { MemoryEntry } from "./types.ts";

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

describe("intelligence security", () => {
  it("an instinct cannot become a permission or execute a tool", async () => {
    const store = new InstinctStore(new MemoryStorage());
    const instinct = await store.observe({ situation: "dev", action: "run tests first" });
    assert.equal(store.isPolicy(instinct), false);
    const runtime = await testRuntime();
    const listed = runtime.tools.list("general").map((tool) => tool.name);
    assert.ok(listed.includes("instinct_observe"));
    assert.ok(!listed.includes("disk_wipe") || runtime.tools.get("disk_wipe")?.spec.permission === "never");
  });

  it("inferred memory cannot overwrite a stated preference", () => {
    const decision = reviseMemory(
      mem({ key: "colour", value: "blue", category: "preference", provenance: { origin: "user", kind: "stated" } }),
      mem({
        key: "colour",
        value: "red",
        category: "preference",
        provenance: { origin: "agent", kind: "inferred" },
        updatedAt: "2026-09-09T00:00:00.000Z",
      }),
    );
    assert.equal(decision.action, "reject");
  });

  it("a cloud packet cannot carry secrets or never-tier capabilities", () => {
    const packet = buildTaskPacket({
      task: "delegate",
      workspaceId: "dev",
      memories: [mem({ key: "password", value: "hunter2", category: "config" })],
      allowedCapabilities: ["search", "shell"],
    });
    assert.equal(packet.context.length, 0);
    assert.ok(!packet.allowedCapabilities.includes("shell"));
  });

  it("returned cloud artifacts cannot claim a local tool ran", () => {
    const result = validateReturnedArtifact({ executed: true, claimedGrant: true });
    assert.equal(result.ok, false);
  });

  it("routing never executes; a never-tier tool cannot be the plan", () => {
    const plan = planExecution({
      intent: "wipe the disk",
      catalog: {
        procedures: [],
        skills: [],
        tools: [{ name: "disk_wipe", permission: "never" }],
      },
    });
    assert.equal(plan.executed, false);
    assert.notEqual(plan.name, "disk_wipe");
  });

  it("intelligence tools still go through the permission gate", async () => {
    const runtime = await testRuntime();
    const denied = await runtime.tools.invoke({ name: "disk_wipe", args: {}, workspaceId: "general" });
    assert.equal(denied.decision.allowed, false);
    const now = await runtime.tools.invoke({ name: "context_now", args: { query: "colour" }, workspaceId: "general" });
    assert.equal(now.result?.ok, true);
    assert.equal(now.result?.epistemic, "checked");
  });

  it("graph_relate cannot smuggle a secret", async () => {
    const runtime = await testRuntime();
    const result = await runtime.tools.invoke({
      name: "graph_relate",
      args: { fromLabel: "user", fromType: "person", toLabel: "api_key sk-live", toType: "resource", edge: "uses" },
      workspaceId: "general",
    });
    assert.equal(result.result?.ok, false);
  });
});
