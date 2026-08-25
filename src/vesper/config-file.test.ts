import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config.ts";
import { loadHostConfig, writeConfigIfMissing } from "./config-file.ts";

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

  it("falls back to defaults when JSON is corrupt", async () => {
    const dir = join(tmpdir(), `vesper-cfg-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeFile(path, "{not-json", "utf8");
    const loaded = await loadHostConfig(path);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.source, "default");
    assert.equal(loaded.config.identity.name, "Vesper");
  });
});
