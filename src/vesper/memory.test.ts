import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory/store.ts";
import { MemoryStorage } from "./storage.ts";

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
});
