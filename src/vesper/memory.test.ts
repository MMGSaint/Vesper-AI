import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory/store.ts";
import { FileStorage, MemoryStorage } from "./storage.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "./types.ts";

function seededStorage(entries: unknown[]): MemoryStorage {
  return new MemoryStorage({ "memory.entries": entries as unknown as JsonValue });
}

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

  it("exports persistent memories and merges an import without session data", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await store.remember({ category: "fact", key: "pc", value: "9950X" });
    await store.remember({ category: "session", key: "now", value: "ephemeral" });
    const exported = await store.exportPersistent();
    assert.equal(exported.some((entry) => entry.category === "session"), false);
    const other = new MemoryStore(new MemoryStorage());
    const result = await other.importPersistent(
      [...exported, { key: "pc", value: "9950X/96GB", category: "fact" }, { nope: true }],
      "merge",
    );
    assert.equal(result.imported >= 1, true);
    assert.equal(result.skipped, 1);
    assert.equal((await other.retrieve("pc"))?.value, "9950X/96GB");
  });

  it("answers a natural-language question instead of matching the whole sentence", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await store.remember({
      category: "routine",
      key: "streaming-schedule",
      value: "I stream on Fridays at 8pm",
    });
    await store.remember({ category: "preference", key: "tone", value: "direct and calm" });

    const hits = await store.search("what did I say about streaming on Fridays");
    assert.equal(hits[0]?.key, "streaming-schedule");
    // Filler words must not drag in unrelated memories.
    assert.equal(hits.length, 1);
    assert.equal((await store.search("tone preferences"))[0]?.key, "tone");
  });

  it("ranks an exact key above a partial term match", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await store.remember({ category: "fact", key: "gpu", value: "RX 7900 XT" });
    await store.remember({
      category: "context",
      key: "build-notes",
      value: "the gpu sits under the cpu cooler and the case has a gpu support bracket",
    });
    const hits = await store.search("gpu");
    assert.equal(hits[0]?.key, "gpu");
  });

  it("weights the active workspace above a global memory", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await store.remember({ category: "fact", key: "editor", value: "vim", scope: "global" });
    await store.remember({
      category: "fact",
      key: "editor",
      value: "vim",
      workspaceId: "development",
    });
    const hits = await store.search("editor", { workspaceId: "development" });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.workspaceId, "development");
    assert.equal(hits[1]?.workspaceId, undefined);
  });

  it("keeps working when a persisted entry is corrupt and records why", async () => {
    const storage = seededStorage([
      {
        id: "mem_good",
        category: "fact",
        key: "pc",
        value: "9950X",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        source: "user",
      },
      { id: "mem_bad", key: 42, value: null },
      null,
      "not an entry",
      ["nested", "array"],
      { id: "mem_partial", key: "snack", value: "pretzels", category: "not-a-category" },
    ]);
    const store = new MemoryStore(storage);

    assert.equal((await store.search("pc"))[0]?.value, "9950X");
    assert.equal((await store.retrieve("snack"))?.value, "pretzels");
    // The unusable record is dropped; the repairable one is repaired, not discarded.
    assert.equal((await store.stats()).persistent, 2);
    assert.match(await store.summarize(), /9950X/);
    assert.equal((await store.all()).length, 2);

    const notices = store.notices();
    assert.equal(notices.filter((notice) => notice.kind === "skipped").length, 4);
    assert.ok(notices.some((notice) => notice.kind === "repaired" && notice.key === "snack"));
    assert.equal((await store.health()).skipped, 4);
  });

  it("survives stored memory that is not a list at all", async () => {
    const store = new MemoryStore(new MemoryStorage({ "memory.entries": { broken: true } }));
    assert.deepEqual(await store.search("anything"), []);
    const stored = await store.remember({ category: "fact", key: "pc", value: "9950X" });
    assert.equal((await store.retrieve(stored.id))?.value, "9950X");
    assert.ok(store.notices().some((notice) => /not a list/.test(notice.reason)));
  });

  it("stores a global memory that every workspace can see", async () => {
    const store = new MemoryStore(new MemoryStorage());
    await store.remember({
      category: "fact",
      key: "handle",
      value: "deadpool54149",
      workspaceId: "gaming",
      scope: "global",
    });
    await store.remember({
      category: "fact",
      key: "repo",
      value: "vesper checkout",
      workspaceId: "development",
    });

    assert.equal((await store.search("handle", { workspaceId: "mortis" }))[0]?.key, "handle");
    assert.deepEqual(await store.search("repo", { workspaceId: "gaming" }), []);
    assert.equal(
      (await store.search("repo", { workspaceId: "gaming", scope: "all" }))[0]?.key,
      "repo",
    );
  });

  it("bounds the store, evicting agent notes before anything the user stated", async () => {
    const store = new MemoryStore(new MemoryStorage(), { maxPersistentEntries: 4 });
    for (let index = 0; index < 6; index += 1) {
      await store.remember({
        category: "context",
        key: `observed-${index}`,
        value: `guess ${index}`,
        source: "agent",
      });
    }
    await store.remember({ category: "fact", key: "stated-fact", value: "I stream on Fridays" });

    const stats = await store.stats();
    assert.equal(stats.persistent, 4);
    assert.equal((await store.retrieve("stated-fact"))?.value, "I stream on Fridays");
    const pruned = store.notices().filter((notice) => notice.kind === "pruned");
    assert.equal(pruned.length, 3);
    assert.ok(pruned.every((notice) => notice.key?.startsWith("observed-")));
    assert.equal((await store.health()).capacity, 4);
  });

  it("never drops a user-stated fact without saying so", async () => {
    const dropped: string[] = [];
    const store = new MemoryStore(new MemoryStorage(), {
      maxPersistentEntries: 2,
      onNotice: (notice) => {
        if (notice.kind === "pruned-stated") dropped.push(notice.key ?? "");
      },
    });
    for (const key of ["a", "b", "c"]) {
      await store.remember({ category: "fact", key, value: `${key} matters`, source: "user" });
    }
    assert.equal((await store.stats()).persistent, 2);
    assert.deepEqual(dropped, ["a"]);
  });
});
