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

  it("recovers when a local backend becomes available after launch", async () => {
    // Regression: providers were probed once, at the end of fire-and-forget discovery,
    // so the first turns after launch used the offline stub even with a backend up,
    // and a backend started later was never noticed at all.
    let backendUp = false;
    let probes = 0;
    const late = {
      id: "ollama",
      kind: "local",
      isAvailable: () => backendUp,
      async probe() {
        probes += 1;
        return { available: backendUp, detail: backendUp ? "up" : "down" };
      },
      complete: async (_request: CompletionRequest, model: string) => ({
        text: "from the local backend",
        toolCalls: [],
        providerId: "ollama",
        model,
        role: "everyday" as const,
      }),
    };
    const router = createModelRouter({ config: defaultConfig(), providers: [late] });
    const ask = () =>
      router.complete({ messages: [{ role: "user", content: "ping" }], role: "everyday" });

    // Backend down: Vesper degrades to the stub, having checked rather than assumed.
    const degraded = await ask();
    assert.equal(degraded.providerId, "echo");
    assert.ok(probes >= 1, "it probes before giving up on a local backend");

    // The user starts Ollama. A failed probe must not lock the next --ask out of
    // trying again: that lock was the launcher/first-boot race.
    backendUp = true;
    const recovered = await ask();
    assert.equal(recovered.providerId, "ollama");
    assert.equal(recovered.text, "from the local backend");

    // Once a local backend is up, an idle assistant must not poll it every turn.
    const probesAfterRecover = probes;
    const again = await ask();
    assert.equal(again.providerId, "ollama");
    assert.equal(probes, probesAfterRecover, "a live local backend is not re-probed every turn");
  });

  it("a completion waits for an in-flight probeAll rather than falling back to echo", async () => {
    // First-boot discovery calls probeAll() in the background. `--ask` calls pick()
    // immediately. If pick treats "probe started" as "probe already tried", the
    // launcher answers with the echo stub while the probe is still in flight.
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let available = false;
    const slow = {
      id: "ollama",
      kind: "local",
      isAvailable: () => available,
      async probe() {
        await barrier;
        available = true;
        return { available: true, detail: "up" };
      },
      complete: async (_request: CompletionRequest, model: string) => ({
        text: "from the local backend",
        toolCalls: [],
        providerId: "ollama",
        model,
        role: "everyday" as const,
      }),
    };
    const router = createModelRouter({ config: defaultConfig(), providers: [slow] });
    const probing = router.probeAll();
    const asking = router.complete({
      messages: [{ role: "user", content: "ping" }],
      role: "everyday",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const result = await asking;
    await probing;
    assert.equal(result.providerId, "ollama");
    assert.equal(result.text, "from the local backend");
  });

  it("asks an installed model when the configured name is not on the daemon", async () => {
    const asked: string[] = [];
    const ollama = {
      id: "ollama",
      kind: "local",
      isAvailable: () => true,
      installedNames: () => ["qwen3:14b"],
      complete: async (_request: CompletionRequest, model: string) => {
        asked.push(model);
        return {
          text: "Paris.",
          toolCalls: [],
          providerId: "ollama",
          model,
          role: "everyday" as const,
        };
      },
    };
    const router = createModelRouter({ config: defaultConfig(), providers: [ollama] });
    const result = await router.complete({
      messages: [{ role: "user", content: "What is the capital of France?" }],
      role: "everyday",
    });
    assert.equal(result.providerId, "ollama");
    assert.equal(result.text, "Paris.");
    assert.deepEqual(asked, ["qwen3:14b"]);
    assert.notEqual(asked[0], "qwen2.5:14b", "the missing default must not go on the wire");
  });
});
