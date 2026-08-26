import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime } from "./runtime.ts";
import { MemoryStorage } from "./storage.ts";

/**
 * End-to-end against a real HTTP server speaking Ollama's protocol.
 *
 * Every other model test injects `fetch`. This one binds a socket and drives the whole
 * stack over it - provider, NDJSON streaming, native tool calls, the agent's tool loop,
 * the permission gate, and memory - so the layers are proven to fit together rather
 * than only in isolation.
 *
 * It is still not hardware validation: the server is a stand-in, no model is loaded,
 * and no number it returns describes real inference.
 */

interface FakeOllama {
  url: string;
  close: () => Promise<void>;
  chatRequests: () => unknown[];
}

async function startFakeOllama(
  reply: (body: Record<string, unknown>, turn: number) => unknown[],
): Promise<FakeOllama> {
  const chatRequests: unknown[] = [];
  let turn = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                name: "qwen2.5:14b",
                size: 9_000_000_000,
                details: { parameter_size: "14.8B", quantization_level: "Q4_K_M", family: "qwen2" },
              },
            ],
          }),
        );
        return;
      }

      if (req.url === "/api/embed") {
        const input = (body.input as string[]) ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings: input.map(() => [0.1, 0.2, 0.3]) }));
        return;
      }

      if (req.url === "/api/chat") {
        chatRequests.push(body);
        turn += 1;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const frame of reply(body, turn)) {
          res.write(`${JSON.stringify(frame)}\n`);
        }
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chatRequests: () => chatRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function runtimeWith(url: string) {
  return createRuntime({
    storage: new MemoryStorage(),
    skipDiscovery: true,
    config: { models: { endpoints: { ollama: url } } },
  });
}

test("live local backend over a real socket", async (t) => {
  await t.test("streams a reply through the whole stack", async () => {
    const backend = await startFakeOllama(() => [
      { message: { role: "assistant", content: "Everything " }, done: false },
      { message: { role: "assistant", content: "looks quiet." }, done: false },
      {
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 42,
        eval_count: 4,
        eval_duration: 200_000_000,
      },
    ]);
    const runtime = await runtimeWith(backend.url);
    await runtime.start();
    try {
      const deltas: string[] = [];
      const turn = await runtime.chat("how are things looking?", {
        onDelta: (delta) => deltas.push(delta),
      });

      assert.equal(turn.reply, "Everything looks quiet.");
      assert.deepEqual(deltas, ["Everything ", "looks quiet."]);
      assert.equal(turn.model?.providerId, "ollama");
      assert.notEqual(turn.model?.unavailable, true, "the local backend was actually used");
      // The request reached the native endpoint, not the OpenAI-compat shim.
      assert.ok(backend.chatRequests().length >= 1);
    } finally {
      await runtime.stop();
      await backend.close();
    }
  });

  await t.test("runs a native tool call and feeds the result back", async () => {
    const backend = await startFakeOllama((_body, turn) =>
      turn === 1
        ? [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "system_info", arguments: {} } }],
              },
              done: false,
            },
            { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
          ]
        : [
            { message: { role: "assistant", content: "I checked the host." }, done: false },
            { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
          ],
    );
    const runtime = await runtimeWith(backend.url);
    await runtime.start();
    try {
      const turn = await runtime.chat("tell me about this machine's cpu");

      assert.equal(turn.reply, "I checked the host.");
      assert.equal(turn.toolCalls.length, 1);
      assert.equal(turn.toolCalls[0].toolName, "system_info");
      assert.equal(turn.toolCalls[0].decision.allowed, true);
      assert.equal(turn.toolCalls[0].result?.ok, true);

      // The second request must carry the assistant's tool call and its result.
      const second = backend.chatRequests()[1] as { messages: { role: string }[] };
      assert.ok(
        second.messages.some((message) => message.role === "tool"),
        "the tool result is sent back to the model",
      );
    } finally {
      await runtime.stop();
      await backend.close();
    }
  });

  await t.test("a later turn is still well-formed after tool use", async () => {
    const backend = await startFakeOllama((_body, turn) =>
      turn === 1
        ? [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "system_info", arguments: {} } }],
              },
              done: true,
            },
          ]
        : [
            { message: { role: "assistant", content: "ok" }, done: false },
            { message: { role: "assistant", content: "" }, done: true },
          ],
    );
    const runtime = await runtimeWith(backend.url);
    await runtime.start();
    try {
      await runtime.chat("check the cpu");
      const second = await runtime.chat("thanks, anything else worth knowing?");
      assert.notEqual(second.model?.unavailable, true, "the conversation did not degrade");

      const last = backend.chatRequests().at(-1) as {
        messages: { role: string; tool_calls?: unknown[] }[];
      };
      for (let i = 0; i < last.messages.length; i += 1) {
        const message = last.messages[i];
        if (message.role === "assistant" && message.tool_calls?.length) {
          assert.equal(
            last.messages[i + 1]?.role,
            "tool",
            "a tool call sent to the backend is always answered",
          );
        }
      }
    } finally {
      await runtime.stop();
      await backend.close();
    }
  });

  await t.test("a backend that dies mid-conversation degrades without crashing", async () => {
    const backend = await startFakeOllama(() => [
      { message: { role: "assistant", content: "still here" }, done: true },
    ]);
    const runtime = await runtimeWith(backend.url);
    await runtime.start();
    try {
      const first = await runtime.chat("hello");
      assert.equal(first.model?.providerId, "ollama");

      // The user closes Ollama.
      await backend.close();

      const second = await runtime.chat("are you still there?");
      assert.ok(second.reply.length > 0, "Vesper still answers");
      assert.notEqual(second.reply, "", "it does not fail silently");
    } finally {
      await runtime.stop();
    }
  });
});
