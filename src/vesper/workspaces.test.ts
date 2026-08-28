import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { MemoryStorage } from "./storage.ts";
import { createRuntime } from "./runtime.ts";

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

describe("workspace load returns an outcome the runtime can act on", () => {
  // The two silent-loss branches from round-2's "loss must be loud" rule: a stored id
  // the config no longer knows about, and a store that could not be read at all. The
  // outcome shape lets the runtime emit a visible event for each without coupling the
  // WorkspaceManager to the EventBus.

  const twoConfig = {
    workspaces: [
      { id: "general", name: "General", description: "" },
      { id: "gaming", name: "Gaming", description: "" },
    ],
    defaultWorkspaceId: "general",
  } as never;

  it("reports 'restored' when the stored id is valid", async () => {
    const storage = new MemoryStorage();
    await storage.set("workspace.current", { currentId: "gaming" });
    const m = new WorkspaceManager(twoConfig, { storage });
    const outcome = await m.load();
    assert.deepEqual(outcome, { kind: "restored", storedId: "gaming" });
  });

  it("reports 'unknown_id' when a stored workspace is gone from the config", async () => {
    const storage = new MemoryStorage();
    await storage.set("workspace.current", { currentId: "obsolete" });
    const m = new WorkspaceManager(twoConfig, { storage });
    const outcome = await m.load();
    assert.deepEqual(outcome, { kind: "unknown_id", storedId: "obsolete" });
    assert.equal(m.current().id, "general", "the current workspace falls back to the default");
  });

  it("reports 'empty' when the store has never been written", async () => {
    const m = new WorkspaceManager(twoConfig, { storage: new MemoryStorage() });
    const outcome = await m.load();
    assert.equal(outcome.kind, "empty");
  });

  it("reports 'unreadable' with an error message when the store throws", async () => {
    const storage = {
      async get() {
        throw new Error("disk is on fire");
      },
      async set() {},
      async delete() {},
      async keys() { return []; },
    };
    const m = new WorkspaceManager(twoConfig, { storage });
    const outcome = await m.load();
    assert.equal(outcome.kind, "unreadable");
    if (outcome.kind === "unreadable") {
      assert.match(outcome.error, /disk is on fire/);
    }
  });

  it("reports 'malformed' when the stored value is not a shape it recognises", async () => {
    const storage = new MemoryStorage();
    await storage.set("workspace.current", { something_else: 42 });
    const m = new WorkspaceManager(twoConfig, { storage });
    const outcome = await m.load();
    assert.equal(outcome.kind, "malformed");
  });

  it("reports 'no_storage' when no adapter was given at all", async () => {
    const m = new WorkspaceManager(twoConfig);
    const outcome = await m.load();
    assert.equal(outcome.kind, "no_storage");
  });

  it("reports 'already_loaded' on the second call, and does not touch storage again", async () => {
    let getCount = 0;
    const storage = {
      async get(k: string) {
        getCount += 1;
        return k === "workspace.current" ? { currentId: "gaming" } : null;
      },
      async set() {},
      async delete() {},
      async keys() { return []; },
    };
    const m = new WorkspaceManager(twoConfig, { storage });
    await m.load();
    const outcome = await m.load();
    assert.equal(outcome.kind, "already_loaded");
    assert.equal(getCount, 1, "second load must not read storage again");
  });
});

describe("the runtime makes silent workspace loss visible", () => {
  it("emits workspace.reset_to_default when a stored workspace no longer exists", async () => {
    // Verify with the real runtime, not a mock: the point is that the loss reaches
    // an event a real user sees in --diagnostics / catchup / events_recent.
    const storage = new MemoryStorage();
    await storage.set("workspace.current", { currentId: "not-a-real-workspace" });
    const runtime = await createRuntime({ storage, skipDiscovery: true });
    await runtime.start();
    const events = runtime.events.recent({ limit: 20 });
    const reset = events.find((event) => event.type === "workspace.reset_to_default");
    assert.ok(reset, "workspace.reset_to_default event was not emitted");
    assert.match(reset.title, /not-a-real-workspace/);
    await runtime.stop();
  });

  it("emits workspace.state_unreadable when the store throws on read", async () => {
    const storage = {
      async get(k: string) {
        if (k === "workspace.current") throw new Error("disk is on fire");
        return null;
      },
      async set() {},
      async delete() {},
      async keys() { return []; },
    };
    const runtime = await createRuntime({ storage, skipDiscovery: true });
    await runtime.start();
    const events = runtime.events.recent({ limit: 20 });
    const bad = events.find((event) => event.type === "workspace.state_unreadable");
    assert.ok(bad, "workspace.state_unreadable event was not emitted");
    assert.match(bad.detail ?? "", /disk is on fire/);
    await runtime.stop();
  });
});
