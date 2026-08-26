import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatProvider } from "./openai-compat.ts";
import type { CompletionRequest } from "../types.ts";

function sse(frames: (unknown | string)[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream);
}

function fakeServer(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const bodies: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function provider(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createOpenAiCompatProvider({
    id: "llamacpp",
    baseUrl: "http://127.0.0.1:8088/v1",
    defaultModel: "test-model",
    kind: "test",
    fetchImpl,
    timeoutMs,
  });
}

const request = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  messages: [{ role: "user", content: "hi" }],
  role: "everyday",
  ...over,
});

test("openai-compatible provider", async (t) => {
  await t.test("streams deltas and records provider-reported usage", async () => {
    const { fetchImpl, bodies } = fakeServer(() =>
      sse([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 11, completion_tokens: 2 }, choices: [] },
      ]),
    );
    const deltas: string[] = [];
    const result = await provider(fetchImpl).complete(
      request({ onDelta: (d) => deltas.push(d) }),
      "test-model",
    );

    assert.equal(result.text, "Hello");
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(result.streamed, true);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.promptTokens, 11);
    assert.equal(result.usage?.completionTokens, 2);
    assert.ok(result.timing!.ttftMs !== null);
    assert.equal((bodies[0] as { stream?: boolean }).stream, true);
  });

  await t.test("reassembles tool-call arguments split across frames", async () => {
    const { fetchImpl } = fakeServer(() =>
      sse([
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "open_app" } }] } },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"app":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"obs"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const result = await provider(fetchImpl).complete(request({ onDelta: () => {} }), "test-model");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "open_app");
    assert.deepEqual(result.toolCalls[0].arguments, { app: "obs" });
    assert.equal(result.toolCalls[0].id, "call_1");
  });

  await t.test("keeps parallel tool calls separate and ordered", async () => {
    const { fetchImpl } = fakeServer(() =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "system_info", arguments: "{}" } },
                  { index: 1, id: "b", function: { name: "process_list", arguments: "{}" } },
                ],
              },
            },
          ],
        },
      ]),
    );
    const result = await provider(fetchImpl).complete(request({ onDelta: () => {} }), "test-model");
    assert.deepEqual(
      result.toolCalls.map((c) => c.name),
      ["system_info", "process_list"],
    );
  });

  await t.test("non-streamed replies report ttft as null rather than faking it", async () => {
    const { fetchImpl } = fakeServer(() =>
      Response.json({
        choices: [{ message: { content: "plain" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
    );
    const result = await provider(fetchImpl).complete(request(), "test-model");
    assert.equal(result.text, "plain");
    assert.equal(result.streamed, false);
    assert.equal(result.timing?.ttftMs, null, "TTFT is unmeasurable without streaming");
    assert.equal(result.usage?.completionTokens, 1);
  });

  await t.test("usage stays null when the server does not report it", async () => {
    const { fetchImpl } = fakeServer(() =>
      Response.json({ choices: [{ message: { content: "x" } }] }),
    );
    const result = await provider(fetchImpl).complete(request(), "test-model");
    assert.equal(result.usage?.promptTokens, null);
    assert.equal(result.usage?.completionTokens, null);
  });

  await t.test("refuses to follow a redirect that could replay credentials", async () => {
    const { fetchImpl } = fakeServer(
      () => new Response(null, { status: 302, headers: { location: "http://evil.test/v1" } }),
    );
    const result = await provider(fetchImpl).complete(request(), "test-model");
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? "", /Refused redirect/);
  });

  await t.test("caller cancellation is distinguished from an outage", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeServer(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
          queueMicrotask(() => controller.abort());
        }),
    );
    const result = await provider(fetchImpl).complete(
      request({ signal: controller.signal }),
      "test-model",
    );
    assert.equal(result.aborted, true);
    assert.notEqual(result.unavailable, true);
  });

  await t.test("timeout is reported as unavailable, not as a cancellation", async () => {
    const { fetchImpl } = fakeServer(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const result = await provider(fetchImpl, 25).complete(request(), "test-model");
    assert.equal(result.unavailable, true);
    assert.notEqual(result.aborted, true);
    assert.match(result.error ?? "", /Timed out after 25ms/);
  });

  await t.test("a malformed SSE frame does not discard the reply", async () => {
    const { fetchImpl } = fakeServer(() =>
      sse([
        { choices: [{ delta: { content: "keep " } }] },
        "{not json",
        { choices: [{ delta: { content: "going" } }] },
      ]),
    );
    const result = await provider(fetchImpl).complete(request({ onDelta: () => {} }), "test-model");
    assert.equal(result.text, "keep going");
  });
});
