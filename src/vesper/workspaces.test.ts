import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";

describe("workspaces", () => {
  it("lists configured workspaces and switches by name", async () => {
    const runtime = await testRuntime();
    const ids = runtime.workspaces.list().map((ws) => ws.id);
    assert.deepEqual(
      ids.sort(),
      ["development", "gaming", "general", "mortis", "streaming", "vrchat"].sort(),
    );
    assert.equal(runtime.workspaces.switchTo("Mortis")?.id, "mortis");
    assert.equal(runtime.workspaces.current().id, "mortis");
    assert.equal(runtime.workspaces.switchTo("does-not-exist"), undefined);
  });
});

describe("the current workspace survives a restart", () => {
  /**
   * Before this, `switchTo` set a field in memory and nothing else. A user typing
   * "switch to gaming" saw "Switched to Gaming." and the next process opened in General,
   * silently, because the choice was never written to disk. Scripts calling
   * `workspace_switch` and scheduled tasks likewise had no durable effect.
   *
   * Persistence is best-effort: the switch takes effect in memory before the write
   * starts, and a failed write is logged rather than surfaced. Callers do not await
   * disk on every switch.
   */
  it("remembers the choice across two runtimes sharing storage", async () => {
    const { MemoryStorage } = await import("./storage.ts");
    const { WorkspaceManager } = await import("./workspaces.ts");
    const { defaultConfig } = await import("./config.ts");

    const storage = new MemoryStorage();
    const config = defaultConfig();

    const first = new WorkspaceManager(config, { storage });
    await first.load();
    assert.equal(first.current().id, "general", "the default should be general on a clean store");
    const switched = first.switchTo("gaming");
    assert.equal(switched?.id, "gaming");
    // Let the fire-and-forget write settle before the second manager reads.
    await new Promise((resolve) => setImmediate(resolve));

    const second = new WorkspaceManager(config, { storage });
    await second.load();
    assert.equal(second.current().id, "gaming", "the second runtime opened in the wrong workspace");
  });

  it("falls back to the default when the stored id names a workspace the config no longer has", async () => {
    // A workspace can be removed from the config at any time. The stored value must not
    // resurrect it — that would be untrusted persisted state deciding what Vesper thinks
    // it is.
    const { MemoryStorage } = await import("./storage.ts");
    const { WorkspaceManager } = await import("./workspaces.ts");
    const { defaultConfig } = await import("./config.ts");

    const storage = new MemoryStorage();
    await storage.set("workspace.current", { currentId: "not-in-my-config" } as never);

    const manager = new WorkspaceManager(defaultConfig(), { storage });
    await manager.load();
    assert.equal(manager.current().id, "general");
  });

  it("shrugs off unreadable stored state without throwing", async () => {
    // If the store is corrupt or the value is the wrong shape, load() must not throw —
    // the runtime's start would fail and Vesper would not come up.
    const { MemoryStorage } = await import("./storage.ts");
    const { WorkspaceManager } = await import("./workspaces.ts");
    const { defaultConfig } = await import("./config.ts");

    const storage = new MemoryStorage();
    for (const nonsense of ["a string, not a record", 42, null, [1, 2, 3], { currentId: 99 }]) {
      await storage.set("workspace.current", nonsense as never);
      const manager = new WorkspaceManager(defaultConfig(), { storage });
      await assert.doesNotReject(manager.load());
      assert.equal(manager.current().id, "general");
    }
  });

  it("still works with no storage adapter at all, for tests and embedded use", async () => {
    // Narrowing, not severing: the manager must not require a storage adapter.
    const { WorkspaceManager } = await import("./workspaces.ts");
    const { defaultConfig } = await import("./config.ts");
    const manager = new WorkspaceManager(defaultConfig());
    await manager.load();
    assert.equal(manager.current().id, "general");
    manager.switchTo("gaming");
    assert.equal(manager.current().id, "gaming");
  });
});
