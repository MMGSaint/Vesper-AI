import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaProvider, nativeRoot, parseParameterSize } from "./ollama.ts";
import type { CompletionRequest } from "../types.ts";

/** Build a streaming Response body from NDJSON lines, one chunk per line. */
function ndjson(lines: unknown[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        const text = typeof line === "string" ? line : JSON.stringify(line);
        controller.enqueue(encoder.encode(`${text}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, init);
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fake Ollama server. Routes by path so tests read like the real contract. */
function fakeOllama(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    // Honour abort so cancellation tests behave like the network does.
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return route({ url, init });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = "http://127.0.0.1:11434/v1";

function baseRequest(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    role: "everyday",
    ...overrides,
  };
}

test("ollama provider", async (t) => {
  await t.test("nativeRoot strips the OpenAI-compat suffix", () => {
    assert.equal(nativeRoot("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
    assert.equal(nativeRoot("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434");
    assert.equal(nativeRoot("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  });

  await t.test("parses parameter sizes and refuses to guess unknown shapes", () => {
    assert.equal(parseParameterSize("14.8B"), 14.8);
    assert.equal(parseParameterSize("7B"), 7);
    assert.equal(parseParameterSize("335M"), 0.335);
    assert.equal(parseParameterSize("enormous"), null);
    assert.equal(parseParameterSize(undefined), null);
  });

  await t.test("probe reports installed model count", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/tags": () =>
        Response.json({ models: [{ name: "qwen2.5:14b" }, { name: "qwen2.5-coder:7b" }] }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "qwen2.5:14b", fetchImpl });
    const result = await provider.probe();
    assert.equal(result.available, true);
    assert.match(result.detail, /2 installed model/);
    assert.equal(provider.isAvailable(), true);
  });

  await t.test("probe is honest when nothing answers", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.probe();
    assert.equal(result.available, false);
    assert.match(result.detail, /No Ollama server answered/);
  });

  await t.test("probe distinguishes reachable-but-empty from unreachable", async () => {
    const { fetchImpl } = fakeOllama({ "/api/tags": () => Response.json({ models: [] }) });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.probe();
    assert.equal(result.available, true);
    assert.match(result.detail, /no models are installed/);
  });

  await t.test("listModels surfaces size and quantization metadata", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/tags": () =>
        Response.json({
          models: [
            {
              name: "qwen2.5:14b",
              size: 9_000_000_000,
              details: { parameter_size: "14.8B", quantization_level: "Q4_K_M", family: "qwen2" },
            },
            { name: "mystery:latest", size: 1_000, details: {} },
          ],
        }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const models = await provider.listModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].name, "qwen2.5:14b");
    assert.equal(models[0].parameterSizeB, 14.8);
    assert.equal(models[0].quantization, "Q4_K_M");
    assert.equal(models[0].family, "qwen2");
    assert.ok(models[0].sizeGB && models[0].sizeGB > 8);
    // Unknown metadata stays null rather than being invented.
    assert.equal(models[1].parameterSizeB, null);
    assert.equal(models[1].quantization, null);
  });

  await t.test("contextLength reads /api/show and stays null when absent", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/show": () => Response.json({ model_info: { "qwen2.llama.context_length": 32768 } }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    assert.equal(await provider.contextLength("qwen2.5:14b"), 32768);

    const bare = fakeOllama({ "/api/show": () => Response.json({}) });
    const provider2 = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl: bare.fetchImpl });
    assert.equal(await provider2.contextLength("qwen2.5:14b"), null);
  });

  await t.test("resident reports loaded models and VRAM", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/ps": () =>
        Response.json({ models: [{ name: "qwen2.5:14b", size_vram: 9_500_000_000 }] }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const loaded = await provider.resident();
    assert.deepEqual(loaded, [{ model: "qwen2.5:14b", vramBytes: 9_500_000_000 }]);
  });

  await t.test("complete streams deltas and reports provider token counters", async () => {
    const { fetchImpl, calls } = fakeOllama({
      "/api/chat": () =>
        ndjson([
          { message: { role: "assistant", content: "Hel" }, done: false },
          { message: { role: "assistant", content: "lo" }, done: false },
          { message: { role: "assistant", content: " there" }, done: false },
          {
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 18,
            eval_count: 3,
            eval_duration: 150_000_000,
            load_duration: 20_000_000,
          },
        ]),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const deltas: string[] = [];
    const result = await provider.complete(
      baseRequest({ onDelta: (d) => deltas.push(d) }),
      "qwen2.5:14b",
    );

    assert.equal(result.text, "Hello there");
    assert.deepEqual(deltas, ["Hel", "lo", " there"]);
    assert.equal(result.streamed, true);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.promptTokens, 18);
    assert.equal(result.usage?.completionTokens, 3);
    assert.equal(result.usage?.evalDurationMs, 150);
    assert.equal(result.usage?.loadDurationMs, 20);
    assert.ok(result.timing);
    assert.ok(result.timing!.ttftMs !== null, "TTFT is measurable when streaming");
    // The request must target the native endpoint, not the /v1 shim.
    assert.equal(new URL(calls[0].url).pathname, "/api/chat");
  });

  await t.test("complete parses native tool calls with object arguments", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/chat": () =>
        ndjson([
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "system_info", arguments: { detail: "full" } } },
                { function: { name: "process_list", arguments: {} } },
              ],
            },
            done: false,
          },
          { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
        ]),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.complete(baseRequest(), "qwen2.5:14b");
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "system_info");
    assert.deepEqual(result.toolCalls[0].arguments, { detail: "full" });
    // Ollama issues no ids; Vesper synthesizes distinct local ones.
    assert.notEqual(result.toolCalls[0].id, result.toolCalls[1].id);
  });

  await t.test("complete tolerates a malformed frame without losing the reply", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/chat": () =>
        ndjson([
          { message: { content: "good " }, done: false },
          "{ this is not json",
          { message: { content: "parts" }, done: true, eval_count: 2 },
        ]),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.complete(baseRequest(), "m");
    assert.equal(result.text, "good parts");
    assert.equal(result.usage?.completionTokens, 2);
  });

  await t.test("complete surfaces an error frame as unavailable", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/chat": () => ndjson([{ error: "model 'ghost' not found" }]),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.complete(baseRequest(), "ghost");
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? "", /not found/);
    assert.equal(result.text, "");
  });

  await t.test("complete reports HTTP failures honestly", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/chat": () => new Response("boom", { status: 500 }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.complete(baseRequest(), "m");
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? "", /HTTP 500/);
  });

  await t.test("complete refuses to follow a redirect", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/chat": () => new Response(null, { status: 302, headers: { location: "http://evil.test/" } }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const result = await provider.complete(baseRequest(), "m");
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? "", /Refused redirect/);
  });

  await t.test("caller cancellation is reported as aborted, not as an outage", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const { fetchImpl } = fakeOllama({
      "/api/chat": (call) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(encoder.encode(`${JSON.stringify({ message: { content: "partial" } })}\n`));
              // The stream stays open; the caller decides when to stop reading.
              call.init?.signal?.addEventListener("abort", () => {
                ctrl.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }),
        ),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl });
    const deltas: string[] = [];
    const result = await provider.complete(
      baseRequest({
        signal: controller.signal,
        // Cancel the moment the user has seen the first token, as Ctrl-C would.
        onDelta: (d) => {
          deltas.push(d);
          controller.abort();
        },
      }),
      "m",
    );
    assert.equal(result.aborted, true);
    assert.notEqual(result.unavailable, true, "cancelling is not a backend outage");
    assert.deepEqual(deltas, ["partial"]);
    assert.equal(result.text, "partial", "text streamed before cancelling is kept");
    assert.match(result.error ?? "", /Cancelled/);
  });

  await t.test("timeout is reported as unavailable with the elapsed budget", async () => {
    const { fetchImpl } = fakeOllama({
      "/api/chat": (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    });
    const provider = createOllamaProvider({
      baseUrl: BASE,
      defaultModel: "x",
      fetchImpl,
      timeoutMs: 25,
    });
    const result = await provider.complete(baseRequest(), "m");
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? "", /Timed out after 25ms/);
  });

  await t.test("embed returns vectors and refuses a mismatched batch", async () => {
    const ok = fakeOllama({
      "/api/embed": () => Response.json({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    });
    const provider = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl: ok.fetchImpl });
    assert.deepEqual(await provider.embed(["a", "b"], "nomic-embed-text"), [[0.1, 0.2], [0.3, 0.4]]);
    assert.deepEqual(await provider.embed([], "nomic-embed-text"), []);

    const short = fakeOllama({ "/api/embed": () => Response.json({ embeddings: [[0.1]] }) });
    const provider2 = createOllamaProvider({ baseUrl: BASE, defaultModel: "x", fetchImpl: short.fetchImpl });
    assert.equal(await provider2.embed(["a", "b"], "nomic-embed-text"), null);
  });
});
