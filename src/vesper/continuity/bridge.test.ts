import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { ProcedureStore } from "../procedures.ts";
import { SkillRegistry } from "../skills.ts";
import { testRuntime } from "../test-helpers.ts";
import { proposeSkillFromProcedure } from "./bridge.ts";

describe("procedure-skill bridge", () => {
  it("an active procedure becomes a scanned skill, never an enabled one", async () => {
    const skills = new SkillRegistry(new MemoryStorage());
    const procedures = new ProcedureStore(new MemoryStorage(), {
      permissionOf: (name) => (name === "memory_remember" ? "safe" : "confirm"),
    });
    const created = await procedures.propose({
      name: "remember prefs",
      purpose: "store a preference",
      steps: [{ instruction: "remember", toolName: "memory_remember", permission: "safe" }],
      provenance: { source: "user", origin: "test" },
    });
    await procedures.review(created.id);
    const active = await procedures.activate(created.id);
    const bridged = await proposeSkillFromProcedure(active, skills, {
      knownTools: ["memory_remember"],
    });
    assert.equal(bridged.ok, true);
    assert.equal(bridged.skill?.state, "scanned");
    assert.notEqual(bridged.skill?.state, "enabled");
  });

  it("a bridged skill still cannot bypass the permission gate", async () => {
    const runtime = await testRuntime();
    const procedures = new ProcedureStore(new MemoryStorage(), {
      permissionOf: (name) => runtime.tools.get(name)?.spec.permission,
    });
    const created = await procedures.propose({
      name: "write notes",
      purpose: "write a file",
      steps: [{ instruction: "write", toolName: "fs_write", permission: "confirm" }],
      provenance: { source: "user", origin: "test" },
    });
    await procedures.review(created.id);
    await procedures.activate(created.id);
    const skills = new SkillRegistry(new MemoryStorage());
    const procedure = await procedures.get(created.id);
    assert.ok(procedure);
    await proposeSkillFromProcedure(procedure, skills, { knownTools: ["fs_write"] });
    const queued = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: "notes/x.md", content: "nope" },
      workspaceId: "general",
    });
    assert.equal(queued.decision.requiresConfirmation, true);
    assert.equal(queued.result, undefined);
  });

  it("a candidate procedure cannot become a skill", async () => {
    const procedures = new ProcedureStore(new MemoryStorage(), {
      permissionOf: () => "safe",
    });
    const created = await procedures.propose({
      name: "draft",
      purpose: "not ready",
      steps: [{ instruction: "think" }],
      provenance: { source: "agent", origin: "test" },
    });
    const skills = new SkillRegistry(new MemoryStorage());
    const bridged = await proposeSkillFromProcedure(created, skills);
    assert.equal(bridged.ok, false);
  });
});
