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
