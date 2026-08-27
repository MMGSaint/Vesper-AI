import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config.ts";
import { loadHostConfig, mergeOverDefaults, writeConfigIfMissing } from "./config-file.ts";

describe("config file", () => {
  it("uses defaults when the file is missing and writes a starter file once", async () => {
    const dir = join(tmpdir(), `vesper-cfg-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    const missing = await loadHostConfig(path);
    assert.equal(missing.source, "default");
    assert.equal(missing.ok, true);
    const wrote = await writeConfigIfMissing(path, defaultConfig());
    assert.equal(wrote, true);
    const second = await writeConfigIfMissing(path, defaultConfig());
    assert.equal(second, false);
    const loaded = await loadHostConfig(path);
    assert.equal(loaded.source, "file");
    assert.equal(loaded.config.identity.name, "Vesper");
    assert.equal(loaded.config.models.allowOptionalCloud, false);
  });

  it("locks down rather than falling back to defaults when JSON is corrupt", async () => {
    // This test used to assert `source === "default"`, which was the defect written down
    // as an expectation: the built-in defaults approve three filesystem roots and index
    // two knowledge sources, so a truncated write *granted* authority to a user who had
    // taken it away. Vesper still starts and still says who it is; it simply starts with
    // nothing approved until the file is repaired.
    const dir = join(tmpdir(), `vesper-cfg-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeFile(path, "{not-json", "utf8");
    const loaded = await loadHostConfig(path);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.source, "locked-down");
    assert.equal(loaded.config.identity.name, "Vesper");
    assert.deepEqual(loaded.config.approvedRoots, []);
    assert.deepEqual(loaded.config.approvedApps, []);
    assert.deepEqual(loaded.config.knowledgeSources, []);
    assert.equal(loaded.config.permissions.lockedDown, true);
  });

  it("still reports a missing file as a clean default, which is a first boot", async () => {
    // The two must stay distinguishable: "no file yet" and "file I cannot read" mean
    // opposite things about what the user intended.
    const dir = join(tmpdir(), `vesper-cfg-none-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const loaded = await loadHostConfig(join(dir, "vesper.json"));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.source, "default");
    assert.equal(loaded.config.permissions.lockedDown, false);
    assert.ok(loaded.config.approvedRoots.length > 0, "a first boot lost its starter roots");
  });

  it("keeps default workspaces, apps, and knowledge sources when the file omits them", async () => {
    // The starter file writers a subset of the config on purpose. A section that is
    // absent must mean "use the default", not "empty" - otherwise a real install boots
    // with no workspaces, no approved applications, and no knowledge sources.
    const dir = join(tmpdir(), `vesper-cfg-subset-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeConfigIfMissing(path, defaultConfig());

    const loaded = await loadHostConfig(path);
    assert.equal(loaded.source, "file");
    assert.deepEqual(
      loaded.config.workspaces.map((workspace) => workspace.id),
      defaultConfig().workspaces.map((workspace) => workspace.id),
    );
    assert.equal(loaded.config.approvedApps.length, defaultConfig().approvedApps.length);
    assert.equal(loaded.config.knowledgeSources.length, defaultConfig().knowledgeSources.length);
  });

  it("respects a deliberately empty list in the file", async () => {
    const dir = join(tmpdir(), `vesper-cfg-empty-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeFile(path, JSON.stringify({ approvedApps: [] }), "utf8");

    const loaded = await loadHostConfig(path);
    assert.equal(loaded.config.approvedApps.length, 0, "an explicit empty list is honoured");
    // ...while untouched sections still come from the defaults.
    assert.ok(loaded.config.workspaces.length > 0);
  });

  it("merges a partially written section instead of replacing it", async () => {
    const dir = join(tmpdir(), `vesper-cfg-partial-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeFile(path, JSON.stringify({ hardware: { mode: "simulated" } }), "utf8");

    const loaded = await loadHostConfig(path);
    assert.equal(loaded.config.hardware.mode, "simulated");
    assert.ok(loaded.config.hardware.target, "the rest of the section keeps its defaults");
  });

  it("ignores prototype keys in a config file", async () => {
    const dir = join(tmpdir(), `vesper-cfg-proto-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeFile(path, '{"__proto__":{"polluted":true},"identity":{"userName":"Sam"}}', "utf8");

    const loaded = await loadHostConfig(path);
    assert.equal(loaded.config.identity.userName, "Sam");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("merge helper replaces arrays and merges objects", () => {
    const merged = mergeOverDefaults(
      { a: { keep: 1, change: 1 }, list: [1, 2, 3], scalar: "old" },
      { a: { change: 2 }, list: [9], scalar: "new" },
    );
    assert.deepEqual(merged, { a: { keep: 1, change: 2 }, list: [9], scalar: "new" });
  });
});
