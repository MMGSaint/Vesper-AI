import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRole, createModelRouter } from "./models/router.ts";
import { defaultConfig } from "./config.ts";
import { createEchoProvider } from "./models/echo.ts";
import { createScriptedProvider } from "./models/scripted.ts";

describe("model routing", () => {
  it("routes coding, reasoning, and default roles", () => {
    assert.equal(resolveRole("refactor this TypeScript function"), "coding");
    assert.equal(resolveRole("why are fans ramping"), "reasoning");
    assert.equal(resolveRole("hello"), "everyday");
  });

  it("falls back when the preferred provider is unavailable", async () => {
    const router = createModelRouter({
      config: defaultConfig(),
      providers: [createEchoProvider()],
    });
    const result = await router.complete({
      messages: [{ role: "user", content: "ping" }],
      role: "everyday",
    });
    assert.equal(result.providerId, "echo");
    assert.equal(result.unavailable, undefined);
  });

  it("returns unavailable from a dead provider then uses fallback", async () => {
    const dead = {
      id: "ollama",
      kind: "local",
      isAvailable: () => true,
      complete: async () => ({
        text: "",
        toolCalls: [],
        providerId: "ollama",
        model: "x",
        role: "everyday" as const,
        unavailable: true,
        error: "down",
      }),
    };
    const router = createModelRouter({
      config: defaultConfig(),
      providers: [dead, createEchoProvider()],
    });
    const result = await router.complete({
      messages: [{ role: "user", content: "hi" }],
      role: "everyday",
    });
    assert.equal(result.providerId, "echo");
  });

  it("scripted provider can emit tool calls", async () => {
    const provider = createScriptedProvider([
      {
        match: "launch discord",
        text: "",
        toolCalls: [{ id: "1", name: "app_launch", arguments: { name: "discord" } }],
      },
    ]);
    const result = await provider.complete(
      { messages: [{ role: "user", content: "launch discord" }], role: "fast" },
      "scripted",
    );
    assert.equal(result.toolCalls[0]?.name, "app_launch");
  });
});
