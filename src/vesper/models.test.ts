import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRole, createModelRouter } from "./models/router.ts";
import { defaultConfig } from "./config.ts";
import { createEchoProvider } from "./models/echo.ts";
import { createScriptedProvider } from "./models/scripted.ts";
import type { CompletionRequest } from "./types.ts";

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

  it("asks the fallback provider for its own model name, not the failed one's", async () => {
    const asked: { provider: string; model: string }[] = [];
    const dead = {
      id: "ollama",
      kind: "local",
      isAvailable: () => true,
      complete: async (_request: CompletionRequest, model: string) => {
        asked.push({ provider: "ollama", model });
        return {
          text: "",
          toolCalls: [],
          providerId: "ollama",
          model,
          role: "everyday" as const,
          unavailable: true,
          error: "connection refused",
        };
      },
    };
    const alive = {
      id: "llamacpp",
      kind: "local",
      defaultModel: "qwen2.5-32b-q4",
      isAvailable: () => true,
      complete: async (_request: CompletionRequest, model: string) => {
        asked.push({ provider: "llamacpp", model });
        return {
          text: "ok",
          toolCalls: [],
          providerId: "llamacpp",
          model,
          role: "everyday" as const,
        };
      },
    };
    const router = createModelRouter({ config: defaultConfig(), providers: [dead, alive] });
    const result = await router.complete({
      messages: [{ role: "user", content: "ping" }],
      role: "everyday",
    });

    assert.equal(result.providerId, "llamacpp");
    // The original failure is preserved so the user learns the primary backend died.
    assert.match(result.error ?? "", /connection refused/);
    assert.equal(asked.length, 2);
    assert.equal(asked[0].model, "qwen2.5:14b", "primary asked for its configured model");
    assert.notEqual(
      asked[1].model,
      asked[0].model,
      "the fallback must not be asked for the failed backend's model name",
    );
    assert.equal(asked[1].model, "qwen2.5-32b-q4");
  });

  it("does not retry another backend when the caller cancelled", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const cancelled = {
      id: "ollama",
      kind: "local",
      isAvailable: () => true,
      complete: async (_request: CompletionRequest, model: string) => {
        calls += 1;
        return {
          text: "",
          toolCalls: [],
          providerId: "ollama",
          model,
          role: "everyday" as const,
          unavailable: true,
          aborted: true,
          error: "Cancelled before the reply finished.",
        };
      },
    };
    const other = {
      id: "llamacpp",
      kind: "local",
      isAvailable: () => true,
      complete: async (_request: CompletionRequest, model: string) => {
        calls += 1;
        return {
          text: "should not happen",
          toolCalls: [],
          providerId: "llamacpp",
          model,
          role: "everyday" as const,
        };
      },
    };
    const router = createModelRouter({ config: defaultConfig(), providers: [cancelled, other] });
    const result = await router.complete({
      messages: [{ role: "user", content: "ping" }],
      role: "everyday",
      signal: controller.signal,
    });

    assert.equal(calls, 1, "a cancelled turn is not re-sent to another backend");
    assert.equal(result.aborted, true);
  });
});
