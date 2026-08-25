import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { classifyIntent } from "./agent.ts";

describe("agent", () => {
  it("classifies remember, status, workspace, optimize, and ready intents", () => {
    assert.equal(classifyIntent("remember that main game is Squad")?.kind, "remember");
    assert.equal(classifyIntent("what's happening")?.kind, "status");
    assert.equal(classifyIntent("switch to vrchat")?.kind, "workspace");
    assert.equal(classifyIntent("optimize this")?.kind, "optimize");
    assert.equal(classifyIntent("get me ready for VRChat")?.kind, "ready");
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
});
