import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attribute,
  defaultScopeFor,
  describesAnotherDevice,
  isPersistable,
  isSyncable,
  isVisibleFrom,
} from "./scopes.ts";
import type { MemoryEntry } from "../types.ts";
import { testRuntime } from "../test-helpers.ts";
import type { ChatMessage, CompletionRequest } from "../types.ts";

function entry(patch: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_1",
    category: "fact",
    key: "gpu",
    value: "Radeon 7900 XT",
    scope: "user",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "user",
    tags: [],
    ...patch,
  } as MemoryEntry;
}

describe("memory scope rules", () => {
  it("keeps session memory off disk and off the wire, together", () => {
    // These two must agree for every scope: anything that never reaches disk cannot
    // reach another device, and a rule that drifted would leak session memory to a peer.
    for (const scope of ["session", "device", "workspace", "user", "global"] as const) {
      assert.equal(
        isPersistable(scope),
        isSyncable(scope),
        `persistability and syncability disagree for '${scope}'`,
      );
    }
    assert.equal(isPersistable("session"), false);
    assert.equal(isSyncable("session"), false);
  });

  it("defaults a plain fact to the person, not the machine they said it on", () => {
    assert.equal(defaultScopeFor({ category: "fact" }), "user");
    assert.equal(defaultScopeFor({ category: "session" }), "session");
    assert.equal(defaultScopeFor({ category: "config", deviceId: "desk-1" }), "device");
    assert.equal(defaultScopeFor({ category: "fact", workspaceId: "mortis" }), "workspace");
    // A config fact with no device attached is not about a device.
    assert.notEqual(defaultScopeFor({ category: "config" }), "device");
  });

  it("keeps workspace facts inside their workspace", () => {
    const scoped = entry({ scope: "workspace", workspaceId: "mortis" });
    assert.equal(isVisibleFrom(scoped, { workspaceId: "mortis" }), true);
    assert.equal(isVisibleFrom(scoped, { workspaceId: "general" }), false);
    // Asking without a workspace is asking about everything.
    assert.equal(isVisibleFrom(scoped, {}), true);
  });

  it("treats an unrecognised scope as the most restrictive thing it could be", () => {
    const strange = entry({ scope: "wormhole" as never });
    assert.equal(isVisibleFrom(strange, { workspaceId: "general" }), false);
  });

  it("does not attribute a device fact to the machine that is asking", () => {
    const desktopFact = entry({ scope: "device", deviceId: "desktop-1" });
    assert.equal(describesAnotherDevice(desktopFact, { deviceId: "laptop-2" }), true);
    assert.equal(describesAnotherDevice(desktopFact, { deviceId: "desktop-1" }), false);
    assert.match(attribute(desktopFact, { deviceId: "laptop-2" }), /on desktop-1/);
    assert.equal(attribute(desktopFact, { deviceId: "desktop-1" }), "Radeon 7900 XT");
  });

  it("does not invent an attribution when the asking device is unknown", () => {
    // Claiming "(on desktop-1)" when we cannot tell who is asking would be a guess.
    const desktopFact = entry({ scope: "device", deviceId: "desktop-1" });
    assert.equal(describesAnotherDevice(desktopFact, {}), false);
  });
});

describe("wiring: a device fact is attributed in the prompt", () => {
  it("never states another machine's hardware as though it were this one's", async () => {
    // The whole reason scopes exist: "my desktop has a 7900 XT" must not become
    // something Vesper believes about the laptop it is currently running on.
    const seen: ChatMessage[][] = [];
    const provider = {
      id: "recorder",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "recorder" };
      },
      async complete(request: CompletionRequest, model: string) {
        seen.push(request.messages);
        return { text: "noted", toolCalls: [], providerId: "recorder", model, role: request.role };
      },
    };
    const runtime = await testRuntime({ providers: [provider] });

    await runtime.memory.remember({
      category: "config",
      key: "graphics card",
      value: "Radeon 7900 XT",
      scopeLevel: "device",
      deviceId: "desktop-1",
      source: "user",
    });

    await runtime.chat("plan a graphics card upgrade with me");

    const system = seen.at(-1)?.find((message) => message.role === "system")?.content ?? "";
    assert.match(system, /7900 XT/, "the fact reached the prompt at all");
    assert.match(
      system,
      /on desktop-1/,
      "another device's hardware was stated without naming the device it belongs to",
    );
  });
});

describe("wiring: the store applies the shared visibility rule", () => {
  it("does not hide a user-scoped fact just because it was recorded in a workspace", async () => {
    // `user` scope means the fact follows the person across contexts. The store filtered
    // on workspaceId alone, without consulting scope, so a preference stated while in
    // one workspace silently vanished in another — the exact opposite of what user
    // scope is for.
    const runtime = await testRuntime();

    await runtime.memory.remember({
      category: "preference",
      key: "coffee",
      value: "oat flat white, no sugar",
      scopeLevel: "user",
      workspaceId: "mortis",
      source: "user",
    });

    const fromElsewhere = await runtime.memory.search("coffee", { workspaceId: "general" });
    assert.ok(
      fromElsewhere.some((item) => item.key === "coffee"),
      "a user-scoped fact was hidden outside the workspace it was recorded in",
    );
  });

  it("still keeps a workspace-scoped fact inside its workspace", async () => {
    // The other half of the same rule: scoping to a workspace must still mean something.
    const runtime = await testRuntime();

    await runtime.memory.remember({
      category: "fact",
      key: "campaign tone",
      value: "grim, low fantasy",
      scopeLevel: "workspace",
      workspaceId: "mortis",
      source: "user",
    });

    const inside = await runtime.memory.search("campaign tone", { workspaceId: "mortis" });
    assert.ok(inside.some((item) => item.key === "campaign tone"));

    const outside = await runtime.memory.search("campaign tone", { workspaceId: "general" });
    assert.equal(
      outside.some((item) => item.key === "campaign tone"),
      false,
      "a workspace-scoped fact leaked into another workspace",
    );
  });
});

describe("the workspace boundary governs writes as well as reads", () => {
  /**
   * `search` filtered through `isVisibleFrom` and `retrieve` filtered on workspaceId,
   * but `update` and `forget` took no scope at all and matched on bare id or key across
   * the whole store. So the boundary the read half calls a rule was not a rule the write
   * half knew about: an entry invisible to search in the active workspace could still be
   * rewritten and deleted from it.
   *
   * `forget` matched on **key**, and a key is not unique — the same key exists in every
   * workspace that stored it — so one call deleted every entry sharing that name
   * everywhere, including the session pool. Reproduced end to end through `memory_forget`,
   * which is reachable by the model.
   */
  async function twoWorkspaces() {
    const runtime = await testRuntime();
    await runtime.memory.remember({
      category: "fact",
      key: "boundary",
      value: "MORTIS-ONLY-SECRET",
      workspaceId: "mortis",
      scope: "workspace",
      source: "user",
    });
    await runtime.memory.remember({
      category: "fact",
      key: "boundary",
      value: "general note",
      workspaceId: "general",
      scope: "workspace",
      source: "user",
    });
    return runtime;
  }

  it("does not delete an entry the asking workspace cannot see", async () => {
    const runtime = await twoWorkspaces();
    const visible = await runtime.memory.search("boundary", { workspaceId: "general" });
    assert.equal(
      visible.some((entry) => entry.value === "MORTIS-ONLY-SECRET"),
      false,
      "the entry was visible from general, so this does not test what it claims",
    );

    const record = await runtime.tools.invoke({
      name: "memory_forget",
      args: { key: "boundary" },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.result?.ok, true, "the workspace's own entry was not forgotten");

    const left = await runtime.memory.search("boundary", { scope: "all" });
    assert.equal(
      left.some((entry) => entry.value === "MORTIS-ONLY-SECRET"),
      true,
      "one workspace deleted a memory belonging to another",
    );
    assert.equal(
      left.some((entry) => entry.value === "general note"),
      false,
      "the entry it could see was not deleted",
    );
    await runtime.stop();
  });

  it("does not rewrite one either", async () => {
    const runtime = await twoWorkspaces();
    const hidden = (await runtime.memory.search("boundary", { scope: "all" })).find(
      (entry) => entry.value === "MORTIS-ONLY-SECRET",
    );
    assert.ok(hidden, "the fixture is wrong");

    const updated = await runtime.memory.update(
      hidden.id,
      { value: "REWRITTEN FROM ANOTHER WORKSPACE" },
      { workspaceId: "general" },
    );
    assert.equal(updated, undefined, "an entry was rewritten from a workspace that cannot see it");

    const after = await runtime.memory.search("boundary", { scope: "all" });
    assert.equal(
      after.some((entry) => entry.value === "MORTIS-ONLY-SECRET"),
      true,
      "the value was changed anyway",
    );
    await runtime.stop();
  });

  it("still forgets and updates within the asking workspace", async () => {
    // Narrowing, not severing.
    const runtime = await twoWorkspaces();
    const mine = (await runtime.memory.search("boundary", { workspaceId: "general" })).find(
      (entry) => entry.value === "general note",
    );
    assert.ok(mine, "the fixture is wrong");

    const updated = await runtime.memory.update(
      mine.id,
      { value: "edited note" },
      { workspaceId: "general" },
    );
    assert.equal(updated?.value, "edited note", "a workspace could not edit its own memory");

    assert.equal(
      await runtime.memory.forget("boundary", { workspaceId: "general" }),
      true,
      "a workspace could not forget its own memory",
    );
    await runtime.stop();
  });

  it("still lets an unscoped caller reach everything, which is what maintenance needs", async () => {
    // The CLI and the maintenance paths name no workspace, and `isVisibleFrom` already
    // treats that as unrestricted. Changing it here would break `vesper forget` silently.
    const runtime = await twoWorkspaces();
    assert.equal(await runtime.memory.forget("boundary"), true);
    const left = await runtime.memory.search("boundary", { scope: "all" });
    assert.equal(
      left.some((entry) => entry.key === "boundary"),
      false,
      "an unscoped forget left entries behind",
    );
    await runtime.stop();
  });
});

describe("a memory the assistant wrote does not claim the user said it", () => {
  /**
   * `memory_remember` stamped every write `provenance: { origin: "user-request", kind:
   * "stated" }`. The model calls that tool, and it does not know whether the user stated
   * anything — so a fact the model invented was indistinguishable in the record from one
   * the user actually said.
   *
   * That matters because `attribute()` renders the difference back into the system prompt
   * on every later turn. An invented fact stamped "stated" is how it becomes a remembered
   * one, and the model is never the authority on what the user said.
   */
  it("records a model-written memory as inferred by the agent", async () => {
    const runtime = await testRuntime();
    await runtime.tools.invoke({
      name: "memory_remember",
      args: { key: "favourite-colour", value: "green", category: "preference" },
      workspaceId: "general",
      confirmed: true,
    });
    const entry = (await runtime.memory.search("favourite-colour", { scope: "all" })).find(
      (item) => item.key === "favourite-colour",
    );
    assert.ok(entry, "the memory was not written at all");
    assert.equal(entry.source, "agent");
    assert.equal(entry.provenance?.kind, "inferred", "a model-written memory claimed the user stated it");
    assert.notEqual(entry.provenance?.origin, "user-request");
    await runtime.stop();
  });

  it("renders it differently from something the user really said", async () => {
    // The consequence: the prompt has to carry the difference, or recording it is
    // bookkeeping nobody reads.
    const runtime = await testRuntime();
    await runtime.memory.remember({
      category: "preference",
      key: "stated-fact",
      value: "green",
      source: "user",
      provenance: { origin: "user", kind: "stated" },
    });
    await runtime.tools.invoke({
      name: "memory_remember",
      args: { key: "inferred-fact", value: "green", category: "preference" },
      workspaceId: "general",
      confirmed: true,
    });
    const all = await runtime.memory.search("green", { scope: "all" });
    const stated = all.find((item) => item.key === "stated-fact")!;
    const inferred = all.find((item) => item.key === "inferred-fact")!;
    assert.notEqual(
      attribute(stated, { deviceId: runtime.deviceIdentity.deviceId }),
      attribute(inferred, { deviceId: runtime.deviceIdentity.deviceId }),
      "the two read identically in the prompt",
    );
    await runtime.stop();
  });
});
