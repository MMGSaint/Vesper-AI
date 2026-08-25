import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "./runtime.ts";
import { MemoryStorage, loadJsonOrDefault } from "./storage.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config.ts";

describe("recovery", () => {
  it("uses defaults for corrupted configuration", () => {
    const parsed = parseConfig({ models: "nope" });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.config.identity.name, "Vesper");
  });

  it("loadJsonOrDefault flags corruption", async () => {
    const dir = join(tmpdir(), `vesper-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "broken.json");
    await writeFile(file, "{not json", "utf8");
    const result = await loadJsonOrDefault(file, { ok: true });
    assert.equal(result.corrupted, true);
    assert.equal(result.usedDefault, true);
    assert.deepEqual(result.value, { ok: true });
  });

  it("agent errors become a recovered turn", async () => {
    const runtime = await createRuntime({ skipDiscovery: true, storage: new MemoryStorage() });
    await runtime.start();
    const original = runtime.agent.handle.bind(runtime.agent);
    runtime.agent.handle = async () => {
      throw new Error("injected failure");
    };
    const turn = await runtime.chat("hello");
    assert.match(turn.reply, /recovered/);
    runtime.agent.handle = original;
  });
});
