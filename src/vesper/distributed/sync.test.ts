import assert from "node:assert/strict";
import test from "node:test";
import {
  SyncEngine,
  filterForSync,
  resolveMemoryConflict,
  selectForQuery,
  type SyncTransport,
} from "./sync.ts";
import type { MemoryEntry, MemoryScopeLevel } from "../types.ts";

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_1",
    category: "fact",
    key: "gpu",
    value: "RX 7900 XT",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "user",
    scope: "user" as MemoryScopeLevel,
    revision: 1,
    ...over,
  };
}

test("conflict resolution", async (t) => {
  await t.test("agreement is not a conflict", () => {
    const result = resolveMemoryConflict(entry(), entry({ id: "mem_2" }));
    assert.equal(result.decision, "identical");
  });

  await t.test("a strictly newer revision wins", () => {
    const local = entry({ revision: 3, value: "newer" });
    const remote = entry({ revision: 2, value: "older" });
    assert.equal(resolveMemoryConflict(local, remote).decision, "local");
    assert.equal(resolveMemoryConflict(remote, local).decision, "remote");
  });

  await t.test("device facts about different machines are never merged", () => {
    // Both are true. Picking one would make Vesper wrong about a machine.
    const desktop = entry({ scope: "device", deviceId: "dev_desktop", value: "RX 7900 XT", revision: 5 });
    const laptop = entry({ scope: "device", deviceId: "dev_laptop", value: "RTX 4060", revision: 1 });
    const result = resolveMemoryConflict(desktop, laptop);

    assert.equal(result.decision, "conflict", "even though the desktop revision is far ahead");
    assert.match(result.reason, /different machines/);
    assert.equal(result.winner, undefined, "neither is discarded");
  });

  await t.test("independent edits from the same base are surfaced, not coin-flipped", () => {
    const local = entry({ revision: 2, value: "I stream on Fridays" });
    const remote = entry({ revision: 2, value: "I stream on Saturdays" });
    const result = resolveMemoryConflict(local, remote);
    assert.equal(result.decision, "conflict");
    assert.match(result.reason, /edited revision 2 independently/);
    assert.match(result.reason, /Neither version is discarded/);
  });

  await t.test("resolution is symmetric, so two devices never disagree about the outcome", () => {
    const a = entry({ revision: 2, value: "a" });
    const b = entry({ revision: 2, value: "b" });
    assert.equal(resolveMemoryConflict(a, b).decision, resolveMemoryConflict(b, a).decision);
  });
});

test("what may leave the device", async (t) => {
  await t.test("session memory never syncs", () => {
    const result = filterForSync([entry({ scope: "session", key: "scratch" })]);
    assert.equal(result.send.length, 0);
    assert.match(result.withheld[0].reason, /never leaves the device/);
  });

  await t.test("anything that looks like a credential is withheld regardless of scope", () => {
    const result = filterForSync([
      entry({ key: "github_token", value: "ghp_example", scope: "user" }),
      entry({ key: "note", value: "my password is hunter2", scope: "user" }),
      entry({ key: "gpu", value: "RX 7900 XT", scope: "user" }),
    ]);
    assert.equal(result.send.length, 1);
    assert.equal(result.send[0].key, "gpu");
    assert.equal(result.withheld.length, 2);
    for (const item of result.withheld) assert.match(item.reason, /credential/);
  });

  await t.test("a scoped pull retrieves only what was asked for", () => {
    const all = [
      entry({ key: "obs-scene", value: "streaming scene collection", scope: "workspace", workspaceId: "streaming" }),
      entry({ key: "editor", value: "vim", scope: "user" }),
      entry({ key: "gaming-note", value: "squad settings", scope: "workspace", workspaceId: "gaming" }),
    ];
    // A portable session asking about streaming must not pull the user's whole store.
    const selected = selectForQuery(all, { match: "streaming", limit: 10 });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].key, "obs-scene");

    const scoped = selectForQuery(all, { scopes: ["workspace"], workspaceId: "gaming" });
    assert.deepEqual(scoped.map((item) => item.key), ["gaming-note"]);
  });

  await t.test("a pull is bounded even when the query is wide open", () => {
    const many = Array.from({ length: 500 }, (_, i) => entry({ key: `k${i}` }));
    assert.equal(selectForQuery(many, {}).length, 50);
    assert.equal(selectForQuery(many, { limit: 5 }).length, 5);
  });
});

test("offline-first sync engine", async (t) => {
  function transport(over: Partial<SyncTransport> = {}): SyncTransport {
    return {
      push: async () => undefined,
      pull: async () => [],
      ...over,
    };
  }

  await t.test("a failed push keeps the queue instead of dropping work", async () => {
    const engine = new SyncEngine();
    engine.enqueue([entry({ key: "gpu" })]);
    assert.equal(engine.pending, 1);

    const outcome = await engine.exchange({
      transport: transport({
        push: async () => {
          throw new Error("network unreachable");
        },
      }),
      local: [],
      query: {},
      apply: () => undefined,
    });

    assert.equal(outcome.applied, 0);
    assert.match(outcome.offlineReason ?? "", /still queued/);
    assert.equal(engine.pending, 1, "the change survives to be sent later");
  });

  await t.test("the queue clears only once the peer has taken the changes", async () => {
    const engine = new SyncEngine();
    engine.enqueue([entry({ key: "gpu" })]);
    const outcome = await engine.exchange({
      transport: transport(),
      local: [],
      query: {},
      apply: () => undefined,
    });
    assert.equal(outcome.offlineReason, null);
    assert.equal(engine.pending, 0);
  });

  await t.test("a failed pull is reported rather than looking like success", async () => {
    const engine = new SyncEngine();
    const outcome = await engine.exchange({
      transport: transport({
        pull: async () => {
          throw new Error("timed out");
        },
      }),
      local: [],
      query: {},
      apply: () => undefined,
    });
    assert.equal(outcome.applied, 0);
    assert.match(outcome.offlineReason ?? "", /Pull failed: timed out/);
  });

  await t.test("only the newest version of a fact is queued", () => {
    const engine = new SyncEngine();
    engine.enqueue([entry({ key: "gpu", value: "old", revision: 1 })]);
    engine.enqueue([entry({ key: "gpu", value: "new", revision: 2 })]);
    assert.equal(engine.pending, 1);
  });

  await t.test("secrets never enter the outbound queue", () => {
    const engine = new SyncEngine();
    const result = engine.enqueue([entry({ key: "api_key", value: "sk-example" })]);
    assert.equal(engine.pending, 0);
    assert.equal(result.withheld.length, 1);
  });

  await t.test("incoming records apply, and conflicts are surfaced not applied", async () => {
    const engine = new SyncEngine();
    const applied: MemoryEntry[] = [];
    const outcome = await engine.exchange({
      transport: transport({
        pull: async () => [
          entry({ key: "new-fact", value: "fresh", revision: 1 }),
          entry({ key: "gpu", value: "remote version", revision: 2 }),
          entry({ key: "editor", value: "diverged", revision: 2 }),
        ],
      }),
      local: [
        entry({ key: "gpu", value: "local version", revision: 1 }),
        entry({ key: "editor", value: "also diverged", revision: 2 }),
      ],
      query: {},
      apply: (item) => {
        applied.push(item);
      },
    });

    assert.equal(outcome.applied, 2, "the new fact and the strictly newer one");
    assert.deepEqual(applied.map((item) => item.key).sort(), ["gpu", "new-fact"]);
    assert.equal(outcome.conflicts.length, 1);
    assert.equal(outcome.conflicts[0].key, "editor");
    assert.ok(
      !applied.some((item) => item.key === "editor"),
      "a conflicted record is never silently applied",
    );
  });

  await t.test("an incoming secret is refused even if a peer sends one", async () => {
    const engine = new SyncEngine();
    const applied: MemoryEntry[] = [];
    const outcome = await engine.exchange({
      transport: transport({ pull: async () => [entry({ key: "aws_secret", value: "leak" })] }),
      local: [],
      query: {},
      apply: (item) => {
        applied.push(item);
      },
    });
    assert.equal(applied.length, 0);
    assert.equal(outcome.withheld.length, 1);
  });
});
