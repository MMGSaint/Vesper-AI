import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "./storage.ts";
import { scanSkill, SkillRegistry } from "./skills.ts";

const clean = {
  name: "notes-helper",
  version: "1.0.0",
  description: "Helps organise local notes",
  requiredTools: ["fs_list", "fs_read"],
  requiredCapabilities: ["conversation"],
  platforms: ["windows"],
  requiredBinaries: [],
  requiredEnvironment: [],
  trust: "third_party",
};

describe("skill scanner", () => {
  it("blocks malformed metadata and missing fields", () => {
    const missing = scanSkill({ name: "x" });
    assert.equal(missing.state, "blocked");
    assert.ok(missing.findings.some((finding) => finding.id === "missing-field"));

    const badName = scanSkill({ ...clean, name: "notes helper; rm -rf" });
    assert.equal(badName.state, "blocked");
  });

  it("blocks suspicious executables, paths, and secret-looking text", () => {
    const exe = scanSkill({ ...clean, requiredBinaries: ["powershell.exe"] });
    assert.equal(exe.state, "blocked");
    assert.ok(exe.findings.some((finding) => finding.id === "suspicious-binary"));

    const path = scanSkill({ ...clean, requiredBinaries: ["C:\\\\Windows\\\\System32\\\\cmd.exe"] });
    assert.equal(path.state, "blocked");

    const secret = scanSkill({ ...clean, description: "uses api_key sk-live-123" });
    assert.equal(secret.state, "blocked");

    const env = scanSkill({ ...clean, requiredEnvironment: ["OPENAI_API_KEY=sk-secret"] });
    assert.equal(env.state, "blocked");
  });

  it("blocks undeclared tools when a catalog is provided", () => {
    const scanned = scanSkill(
      { ...clean, requiredTools: ["disk_wipe"] },
      { knownTools: ["fs_list", "fs_read"] },
    );
    assert.equal(scanned.state, "blocked");
  });

  it("does not enable a third-party skill just because it was discovered", async () => {
    const registry = new SkillRegistry(new MemoryStorage());
    const found = await registry.discover(clean, { knownTools: ["fs_list", "fs_read"] });
    assert.equal(found.state, "scanned");
    assert.equal(found.manifest.trust, "third_party");
    const listed = await registry.list();
    assert.equal(listed.filter((item) => item.state === "enabled").length, 0);
  });

  it("refuses to enable a blocked skill, and enable does not register tools", async () => {
    const registry = new SkillRegistry(new MemoryStorage());
    const blocked = await registry.discover({ ...clean, requiredBinaries: ["cmd.exe"] });
    assert.equal(blocked.state, "blocked");
    await assert.rejects(() => registry.enable(blocked.id), /blocked/);

    const scanned = await registry.discover(clean, { knownTools: ["fs_list", "fs_read"] });
    const enabled = await registry.enable(scanned.id);
    assert.equal(enabled.state, "enabled");
    assert.equal("register" in registry, false);
    assert.equal("invoke" in registry, false);
  });
});
