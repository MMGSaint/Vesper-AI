import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { SkillRegistry, type SkillRegistry as Skills } from "../skills.ts";
import { hashManifest, ProposalError, SkillProposalStore } from "./proposals.ts";

describe("skill proposals", () => {
  it("apply is not enable, and a changed hash becomes stale", async () => {
    const skills = new SkillRegistry(new MemoryStorage());
    const skill = await skills.discover({
      name: "notes",
      version: "1.0.0",
      description: "Local notes helper",
      requiredTools: ["memory_remember"],
      requiredCapabilities: [],
      platforms: ["windows"],
      requiredBinaries: [],
      requiredEnvironment: [],
      trust: "local",
    });
    assert.equal(skill.state, "scanned");
    const store = new SkillProposalStore(new MemoryStorage());
    const proposal = await store.propose(skill);
    assert.equal(proposal.state, "proposed");
    assert.equal(proposal.targetHash, hashManifest(skill.manifest));

    const applied = await store.apply(proposal.id, skills);
    assert.equal(applied.state, "applied");
    const still = await skills.get(skill.id);
    assert.equal(still?.state, "scanned");

    const staleProposal = await store.propose(skill);
    await assert.rejects(
      () =>
        store.apply(staleProposal.id, {
          get: async () => ({
            ...skill,
            manifest: { ...skill.manifest, version: "9.9.9" },
          }),
        } as unknown as Skills),
      ProposalError,
    );
    const listed = await store.list();
    assert.equal(listed.find((item) => item.id === staleProposal.id)?.state, "stale");
  });

  it("rollback requires an applied proposal", async () => {
    const skills = new SkillRegistry(new MemoryStorage());
    const skill = await skills.discover({
      name: "echo",
      version: "1.0.0",
      description: "Echo",
      requiredTools: [],
      requiredCapabilities: [],
      platforms: [],
      requiredBinaries: [],
      requiredEnvironment: [],
      trust: "local",
    });
    const store = new SkillProposalStore(new MemoryStorage());
    const proposal = await store.propose(skill);
    await assert.rejects(() => store.rollback(proposal.id), ProposalError);
    await store.apply(proposal.id, skills);
    const rolled = await store.rollback(proposal.id);
    assert.equal(rolled.state, "rolled_back");
  });
});
