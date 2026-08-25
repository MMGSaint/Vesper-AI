import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory/store.ts";
import { FileStorage, MemoryStorage } from "./storage.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory", () => {
  it("remembers, retrieves, searches, updates, forgets, and summarizes", async () => {
    const store = new MemoryStore(new MemoryStorage());
    const remembered = await store.remember({
      category: "fact",
      key: "main-game",
      value: "Squad",
      source: "user",
    });
    assert.equal((await store.retrieve("main-game"))?.value, "Squad");
    const hits = await store.search("squad");
    assert.equal(hits[0]?.key, "main-game");
    const updated = await store.update(remembered.id, { value: "Squad and VRChat" });
    assert.equal(updated?.value, "Squad and VRChat");
    const summary = await store.summarize();
    assert.match(summary, /Squad and VRChat/);
    assert.equal(await store.forget("main-game"), true);
    assert.equal(await store.retrieve("main-game"), undefined);
  });

  it("updates existing keys instead of duplicating", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await store.remember({ category: "preference", key: "tone", value: "direct" });
    await store.remember({ category: "preference", key: "tone", value: "calm and direct" });
    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.value, "calm and direct");
  });

  it("keeps session memories out of persistent storage", async () => {
    const storage = new MemoryStorage();
    const store = new MemoryStore(storage);
    await store.remember({ category: "session", key: "this-turn", value: "ephemeral" });
    await store.remember({ category: "fact", key: "main-game", value: "Squad" });
    const stats = await store.stats();
    assert.equal(stats.session, 1);
    assert.equal(stats.persistent, 1);
    const restarted = new MemoryStore(storage);
    assert.equal(await restarted.retrieve("this-turn"), undefined);
    assert.equal((await restarted.retrieve("main-game"))?.value, "Squad");
  });

  it("persists across FileStorage restart and recovers from corruption", async () => {
    const dir = join(tmpdir(), `vesper-mem-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "state.json");
    const store = new MemoryStore(new FileStorage(file));
    await store.remember({ category: "fact", key: "pc", value: "9950X" });
    const restarted = new MemoryStore(new FileStorage(file));
    assert.equal((await restarted.retrieve("pc"))?.value, "9950X");

    await writeFile(file, "{not json", "utf8");
    const broken = new FileStorage(file);
    assert.equal(await broken.get("memory.entries"), undefined);
    assert.equal(broken.wasCorrupted(), true);
  });

  it("serializes concurrent writes without losing entries", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.remember({ category: "fact", key: `k${index}`, value: `v${index}` }),
      ),
    );
    const all = await store.all();
    assert.equal(all.length, 12);
  });
});
