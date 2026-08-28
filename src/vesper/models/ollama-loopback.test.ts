import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOllamaProvider } from "./ollama.ts";
import { startOllamaLoopback, type OllamaLoopback } from "./ollama-loopback.ts";
import { testRuntime } from "../test-helpers.ts";
import type { CompletionRequest } from "../types.ts";

/**
 * The provider used to be covered only by tests that stub `fetchImpl`. What those tests
 * could not exercise:
 *
 *   - real HTTP with a real socket (bind, listen, connect, close)
 *   - NDJSON framing broken across arbitrary boundaries
 *   - the full `runtime.chat` loop with model → tool → authorization → execution → result
 *     driven by a socket rather than a function reference.
 *
 * Every test here binds `127.0.0.1:0`, serves the endpoints Ollama serves, and closes
 * the socket in a `finally`. Nothing binds any other interface. Nothing is left running.
 */

async function withLoopback<T>(
  fixture: Parameters<typeof startOllamaLoopback>[0],
  fn: (loopback: OllamaLoopback) => Promise<T>,
): Promise<T> {
  const loopback = await startOllamaLoopback(fixture);
  try {
    return await fn(loopback);
  } finally {
    await loopback.stop();
  }
}

describe("the provider talks to a real socket", () => {
  it("only binds loopback", async () => {
    await withLoopback({}, (loopback) => {
      // Asserted on what the OS reports the socket is actually bound to, not on the URL
      // the harness built for itself — an earlier version checked the string it composed,
      // which stayed 127.0.0.1 even if the server had bound 0.0.0.0. The point of this
      // check is that no test in this file exposes a listener off-host, so it must catch
      // the widening at the syscall boundary rather than at a formatted output.
      assert.equal(loopback.boundAddress, "127.0.0.1", `bound to ${loopback.boundAddress}`);
      return Promise.resolve();
    });
  });

  it("probes /api/tags and reports what the server actually returns", async () => {
    await withLoopback(
      { tags: [{ name: "qwen2.5:3b", parameterSize: "3B", quantization: "Q4_K_M", size: 2_400_000_000 }] },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "qwen2.5:3b" });
        const probe = await provider.probe();
        assert.equal(probe.available, true, probe.detail);
        assert.match(probe.detail, /1 installed model/);
        const seen = loopback.requests.find((r) => r.path === "/api/tags");
        assert.ok(seen, "the provider never called /api/tags");
      },
    );
  });

  it("says a dead port is dead rather than pretending", async () => {
    // A port that has been closed. Nothing answers, nothing was probed, nothing to
    // pretend about. The provider must fail the probe and stay unavailable.
    const loopback = await startOllamaLoopback({});
    await loopback.stop();
    const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "x", probeTimeoutMs: 500 });
    const probe = await provider.probe();
    assert.equal(probe.available, false, `dead port reported ${probe.detail}`);
  });

  it("lists installed models with the fields Vesper uses to pick one", async () => {
    await withLoopback(
      {
        tags: [
          { name: "qwen2.5:14b", parameterSize: "14.8B", quantization: "Q4_K_M", size: 9_200_000_000, family: "qwen2" },
          { name: "unnamed-thing" },
        ],
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "qwen2.5:14b" });
        const models = await provider.listModels();
        assert.equal(models.length, 2);
        const qwen = models.find((m) => m.name === "qwen2.5:14b")!;
        assert.equal(qwen.parameterSizeB, 14.8);
        assert.equal(qwen.quantization, "Q4_K_M");
        assert.equal(qwen.family, "qwen2");
      },
    );
  });

  it("reads /api/show for a real context length, and leaves it null when unknown", async () => {
    await withLoopback(
      { contextLength: { "qwen2.5:14b": 32768 } },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "qwen2.5:14b" });
        assert.equal(await provider.contextLength("qwen2.5:14b"), 32768);
        assert.equal(await provider.contextLength("nope"), null, "missing model must not fabricate a length");
      },
    );
  });

  it("reads /api/ps for resident models with the VRAM they hold", async () => {
    await withLoopback(
      { resident: [{ name: "qwen2.5:14b", vramBytes: 9_600_000_000 }] },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "qwen2.5:14b" });
        const running = await provider.resident();
        assert.equal(running.length, 1);
        assert.equal(running[0].model, "qwen2.5:14b");
        assert.equal(running[0].vramBytes, 9_600_000_000);
      },
    );
  });

  it("embeds a batch and preserves the shape the caller sent", async () => {
    await withLoopback(
      { embeddings: { "nomic-embed-text": [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] } },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "x" });
        const vectors = await provider.embed(["a", "b"], "nomic-embed-text");
        assert.deepEqual(vectors, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
        assert.equal(await provider.embed(["c"], "not-installed"), null, "missing embedding model must not invent vectors");
      },
    );
  });
});

describe("streaming from a real socket", () => {
  it("assembles NDJSON split across writes into one reply, with usage counters", async () => {
    // The whole point: frames the server splits across setImmediate boundaries have to
    // be reassembled by the client. A stubbed fetch that returns a single string cannot
    // exercise this — this is the failure mode a real socket makes possible.
    await withLoopback(
      {
        chat: {
          "loopback-chat": {
            frames: [
              { content: "Hello, " },
              { content: "world" },
              { content: "." },
            ],
            promptEvalCount: 12,
            evalCount: 3,
            evalDurationNs: 1_500_000_000,
            loadDurationNs: 400_000_000,
            finishReason: "stop",
          },
        },
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "loopback-chat" });
        const deltas: string[] = [];
        const request: CompletionRequest = {
          messages: [{ role: "user", content: "say hi" }],
          role: "everyday",
          onDelta: (chunk) => deltas.push(chunk),
        };
        const result = await provider.complete(request, "loopback-chat");
        assert.equal(result.text, "Hello, world.");
        assert.deepEqual(deltas, ["Hello, ", "world", "."], "the reader collapsed frames the server sent separately");
        assert.equal(result.streamed, true);
        assert.equal(result.finishReason, "stop");
        assert.equal(result.usage?.promptTokens, 12, "prompt-token count did not survive the round trip");
        assert.equal(result.usage?.completionTokens, 3);
        assert.equal(result.usage?.evalDurationMs, 1500, "eval duration ns→ms lost precision");
        assert.ok(result.timing?.ttftMs != null && result.timing.ttftMs >= 0);
        assert.ok(result.unavailable !== true, "a successful stream reported unavailable");
      },
    );
  });

  it("surfaces a tool call the model emits", async () => {
    await withLoopback(
      {
        chat: {
          "loopback-tool": {
            frames: [
              { content: "" },
              { toolCall: { name: "system_info", args: {} } },
            ],
            promptEvalCount: 8,
            evalCount: 1,
            finishReason: "tool_calls",
          },
        },
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "loopback-tool" });
        const result = await provider.complete(
          { messages: [{ role: "user", content: "status" }], role: "everyday" },
          "loopback-tool",
        );
        assert.equal(result.toolCalls.length, 1, "the model's tool call was lost");
        assert.equal(result.toolCalls[0].name, "system_info");
        assert.match(result.toolCalls[0].id, /^ollama-tc-/, "Ollama gives no ids, so the provider synthesises them");
      },
    );
  });

  it("refuses to follow a redirect on /api/chat", async () => {
    // A redirect would re-issue the POST — body included — to a host the config never
    // approved. The provider must refuse without following.
    await withLoopback(
      {
        chat: {
          "loopback-redirect": {
            frames: [],
            status: 307,
            location: "http://elsewhere.example/api/chat",
          },
        },
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "loopback-redirect" });
        const result = await provider.complete(
          { messages: [{ role: "user", content: "x" }], role: "everyday" },
          "loopback-redirect",
        );
        assert.equal(result.unavailable, true, "the redirect was followed");
        assert.match(result.error ?? "", /redirect/i);
      },
    );
  });

  it("reports unavailable when the server drops the socket mid-stream", async () => {
    // Real socket failure. The stub can only return; only a real connection can be cut.
    await withLoopback(
      {
        chat: {
          "loopback-cut": {
            frames: [{ content: "partial" }],
            cutBeforeDone: true,
          },
        },
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "loopback-cut" });
        const result = await provider.complete(
          { messages: [{ role: "user", content: "x" }], role: "everyday" },
          "loopback-cut",
        );
        assert.equal(result.unavailable, true, "a dropped socket was reported as success");
      },
    );
  });

  it("returns unavailable rather than throwing when the caller cancels", async () => {
    // The cancellation path — the caller aborts before the first frame. The provider
    // must surface `aborted: true`, not `unavailable`, so the router does not retry
    // elsewhere.
    await withLoopback(
      {
        chat: {
          "loopback-cancel": {
            frames: [{ content: "should never appear" }],
            firstFrameDelayMs: 500,
          },
        },
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "loopback-cancel" });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 30);
        const result = await provider.complete(
          {
            messages: [{ role: "user", content: "x" }],
            role: "everyday",
            signal: controller.signal,
          },
          "loopback-cancel",
        );
        assert.equal(result.aborted, true, "caller cancellation was not surfaced");
        assert.notEqual(result.unavailable, true, "cancelling should not be reported as an outage");
      },
    );
  });
});

describe("the full agent path runs against a real socket", () => {
  it("model → tool call → permission gate → execution → truthful reply", async () => {
    // The whole vertical, once. The router picks by role → provider.id → model.name, so
    // the runtime config points the everyday role at this provider's model, and the
    // loopback serves TWO responses in order: first a tool call, then a plain reply once
    // the tool's result has been fed back. Every one of those steps crosses a real
    // socket.
    await withLoopback(
      {
        chat: {
          "loopback-agent": [
            {
              frames: [{ toolCall: { name: "system_info", args: {} } }],
              promptEvalCount: 42,
              evalCount: 1,
              finishReason: "tool_calls",
            },
            {
              frames: [{ content: "System snapshot delivered." }],
              promptEvalCount: 60,
              evalCount: 4,
              finishReason: "stop",
            },
          ],
        },
      },
      async (loopback) => {
        const provider = createOllamaProvider({ baseUrl: loopback.url, defaultModel: "loopback-agent" });
        const runtime = await testRuntime({
          providers: [provider],
          config: {
            models: {
              roles: { everyday: { provider: "ollama", model: "loopback-agent" } },
              endpoints: { ollama: loopback.url },
            },
          },
        });

        // Free-form question so the deterministic-intent short-circuit at 0.85 confidence
        // does not run first — "what is happening?" hits the `status` intent at 0.93 and
        // the model never runs.
        const turn = await runtime.chat("please describe the weather in Paris in one line", { origin: { kind: "local" } });

        // Consequence-based: the tool actually ran, and its result reached the record —
        // proving the frames the server wrote came in over a socket, were parsed as
        // NDJSON, produced a synthesised tool-call id, and were handed to the tool
        // registry which authorised and executed it.
        const called = turn.toolCalls.find((call) => call.toolName === "system_info");
        assert.ok(called, `system_info was never called: ${JSON.stringify(turn.toolCalls)}`);
        assert.equal(called.result?.ok, true, `system_info did not succeed: ${called.result?.summary}`);
        assert.equal(called.decision.allowed, true, "authorization decision was not recorded");

        // Both model calls actually reached the server: the initial call that returned
        // the tool_call, and the follow-up that returned the plain reply.
        const chatCalls = loopback.requests.filter((r) => r.path === "/api/chat");
        assert.ok(chatCalls.length >= 2, `expected 2 /api/chat calls, saw ${chatCalls.length}`);

        // The final reply carried the model's text, not a deterministic fallback.
        assert.match(turn.reply, /snapshot delivered|System snapshot/i, `reply did not include the model's answer: ${turn.reply}`);

        await runtime.stop();
      },
    );
  });
});
