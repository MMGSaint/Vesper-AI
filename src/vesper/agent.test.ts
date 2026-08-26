import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { classifyIntent, encodeToolResult, fitContext, historyWindow } from "./agent.ts";
import type { ChatMessage, CompletionRequest } from "./types.ts";

describe("agent", () => {
  it("classifies remember, status, workspace, optimize, and ready intents", () => {
    assert.equal(classifyIntent("remember that main game is Squad")?.kind, "remember");
    assert.equal(classifyIntent("what's happening")?.kind, "status");
    assert.equal(classifyIntent("switch to vrchat")?.kind, "workspace");
    assert.equal(classifyIntent("optimize this")?.kind, "optimize");
    assert.equal(classifyIntent("get me ready for VRChat")?.kind, "ready");
    assert.equal(classifyIntent("Vesper diagnostics")?.kind, "diagnostics");
  });

  it("stores memory through the agent", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("remember that main game is Squad");
    assert.match(turn.reply, /Remembered/i);
    const hits = await runtime.memory.search("Squad");
    assert.ok(hits.some((hit) => hit.value.includes("Squad")));
  });

  it("switches workspaces", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("switch to development");
    assert.equal(runtime.workspaces.current().id, "development");
    assert.match(turn.reply, /Development/i);
  });

  it("returns a grounded status without fabricating live telemetry", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("what's happening");
    assert.match(turn.reply, /simulated/i);
    assert.ok(turn.epistemic.includes("checked"));
    assert.ok(turn.toolCalls.some((call) => call.toolName === "system_info"));
  });

  it("queues confirmation for optimizer changes", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("optimize this");
    assert.ok(turn.pendingConfirmations.length >= 1);
    assert.equal(turn.pendingConfirmations[0]?.toolName, "optimizer_request");
    const approved = await runtime.chat("approve", {
      confirmId: turn.pendingConfirmations[0]?.id,
      approve: true,
    });
    assert.match(approved.reply, /mock/i);
  });

  it("denies confirmation without executing", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("optimize this");
    const denied = await runtime.chat("no", {
      confirmId: turn.pendingConfirmations[0]?.id,
      approve: false,
    });
    assert.match(denied.reply, /did not run/i);
  });

  it("survives an unavailable optimizer", async () => {
    const runtime = await testRuntime();
    runtime.setOptimizerAvailable(false);
    const turn = await runtime.chat("what's happening");
    assert.match(turn.reply.toLowerCase(), /could not access|unavailable|optimizer/i);
  });

  it("continues when no production local model is present", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("tell me a story about evening observatories");
    assert.ok(turn.reply.length > 0);
    assert.match(turn.reply, /no local inference backend|No local model|heard you|grounded tools/i);
  });

  it("runs the vrchat ready workflow through tools", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("get me ready for VRChat");
    assert.equal(runtime.workspaces.current().id, "vrchat");
    assert.ok(turn.toolCalls.some((call) => call.toolName === "app_launch"));
    assert.match(turn.reply, /simulated/i);
  });

  it("uses scripted tool calls from a model", async () => {
    const runtime = await testRuntime({
      script: [
        {
          match: "launch discord",
          text: "",
          toolCalls: [{ id: "call_1", name: "app_launch", arguments: { name: "discord" } }],
        },
        { match: /.*/, text: "I changed the simulated Discord state." },
      ],
    });
    const turn = await runtime.chat("please launch discord for me");
    assert.ok(turn.toolCalls.some((call) => call.toolName === "app_launch" && call.result?.ok));
    assert.match(turn.reply, /Discord|changed/i);
  });

  it("keeps tool results in history so later turns stay valid", async () => {
    // Regression: the assistant's tool-call message was recorded but its results were
    // not, leaving history with tool calls that are never answered. A real backend
    // rejects that, so every conversation degraded to the offline stub after the first
    // tool use.
    const seen: ChatMessage[][] = [];
    let call = 0;
    const recorder = {
      id: "recorder",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "recorder" };
      },
      async complete(request: CompletionRequest, model: string) {
        seen.push(request.messages);
        call += 1;
        if (call === 1) {
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "system_info", arguments: {} }],
            providerId: "recorder",
            model,
            role: request.role,
          };
        }
        return { text: "done", toolCalls: [], providerId: "recorder", model, role: request.role };
      },
    };

    const runtime = await testRuntime({ providers: [recorder] });
    await runtime.chat("check the system please");
    await runtime.chat("and now something else");

    const final = seen[seen.length - 1];
    for (let i = 0; i < final.length; i += 1) {
      const message = final[i];
      if (message.role === "assistant" && message.toolCalls?.length) {
        assert.equal(
          final[i + 1]?.role,
          "tool",
          "an assistant tool call must be followed by its result",
        );
      }
      if (message.role === "tool") {
        const previous = final[i - 1];
        assert.ok(
          previous && (previous.role === "assistant" || previous.role === "tool"),
          "a tool result must follow the call it answers",
        );
      }
    }
    assert.ok(
      final.some((message) => message.role === "tool"),
      "the tool result is actually present",
    );
  });

  it("never starts the context window mid-exchange", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", name: "t", toolCallId: "c1", content: "{}" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ];
    // A naive tail would begin on the tool result and orphan it.
    const window = historyWindow(history, 3);
    assert.equal(window[0].role, "user");
    assert.equal(window[0].content, "second");
  });

  it("keeps a huge tool result from crowding out the conversation", () => {
    const huge = { ok: true, epistemic: "checked", summary: "Listed the directory.", data: { text: "x".repeat(50_000) } };
    const encoded = encodeToolResult(huge);
    assert.ok(encoded.length < 4_000, "the payload is bounded");
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    // The parts the model reasons over, and that Vesper's honesty rules rest on, survive.
    assert.equal(parsed.summary, "Listed the directory.");
    assert.equal(parsed.epistemic, "checked");
    assert.equal(parsed.ok, true);
    // And the model is told the view is partial rather than being quietly misled.
    assert.equal(parsed.truncated, true);
    assert.match(String(parsed.note), /50\d{3} characters/);
  });

  it("leaves a small tool result exactly as it was", () => {
    const small = { ok: true, epistemic: "checked", summary: "CPU 8%." };
    assert.equal(encodeToolResult(small), JSON.stringify(small));
  });

  it("trims the oldest exchanges to fit the context budget, keeping the system prompt", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "a".repeat(500) },
      { role: "assistant", content: "b".repeat(500) },
      { role: "user", content: "c".repeat(500) },
      { role: "assistant", content: "d".repeat(500) },
      { role: "user", content: "the current question" },
    ];
    const fitted = fitContext(messages, 900);
    assert.equal(fitted.messages[0].content, "SYSTEM PROMPT", "the system prompt is never dropped");
    assert.ok(fitted.dropped > 0);
    assert.equal(fitted.messages.at(-1)?.content, "the current question");
    // Trimming never leaves the window starting mid-exchange.
    assert.equal(fitted.messages[1]?.role, "user");
  });

  it("does nothing when the conversation already fits", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "hello" },
    ];
    const fitted = fitContext(messages, 10_000);
    assert.equal(fitted.dropped, 0);
    assert.deepEqual(fitted.messages, messages);
  });

  it("stops and says so when the model repeats the same tool call", async () => {
    let calls = 0;
    const stuck = {
      id: "stuck",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "stuck" };
      },
      async complete(request: CompletionRequest, model: string) {
        calls += 1;
        // Always asks for the identical call, learning nothing from the result.
        return {
          text: "",
          toolCalls: [{ id: `c${calls}`, name: "system_info", arguments: {} }],
          providerId: "stuck",
          model,
          role: request.role,
        };
      },
    };
    const runtime = await testRuntime({ providers: [stuck] });
    const turn = await runtime.chat("tell me about the machine");

    assert.match(turn.reply, /repeat the same call to system_info/);
    // It gave up quickly rather than burning the whole iteration budget.
    assert.ok(calls <= 3, `stopped after ${calls} model calls`);
    assert.ok(turn.epistemic.includes("could_not_access"));
  });
});
