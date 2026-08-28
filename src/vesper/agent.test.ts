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

  it("serializes concurrent turns so history is never spliced together", async () => {
    // The console, a scheduled task, and a companion session share one conversation.
    // A turn mutates it in several steps, so interleaving two turns reproduces the
    // dangling-tool-call corruption that history integrity exists to prevent.
    const seen: ChatMessage[][] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const slow = {
      id: "slow",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "slow" };
      },
      async complete(request: CompletionRequest, model: string) {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        seen.push(request.messages);
        inFlight -= 1;
        return { text: "ok", toolCalls: [], providerId: "slow", model, role: request.role };
      },
    };

    const runtime = await testRuntime({ providers: [slow] });
    await Promise.all([
      runtime.chat("first question"),
      runtime.chat("second question"),
      runtime.chat("third question"),
    ]);

    assert.equal(maxConcurrent, 1, "only one turn touches the conversation at a time");
    // Each later turn sees the previous exchange complete, never half of it.
    const last = seen.at(-1)!;
    const userTurns = last.filter((message) => message.role === "user").length;
    assert.ok(userTurns >= 2, "earlier turns are present and whole");
  });

  it("a failed turn does not wedge the queue", async () => {
    let calls = 0;
    const flaky = {
      id: "flaky",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "flaky" };
      },
      async complete(request: CompletionRequest, model: string) {
        calls += 1;
        if (calls === 1) throw new Error("backend exploded");
        return { text: "recovered", toolCalls: [], providerId: "flaky", model, role: request.role };
      },
    };
    const runtime = await testRuntime({ providers: [flaky] });
    const first = await runtime.chat("this one fails");
    assert.ok(first.reply.length > 0, "the failure is reported, not thrown at the user");
    const second = await runtime.chat("this one must still work");
    assert.match(second.reply, /recovered/);
  });

  it("understands a memory category in conversation, as the console does", async () => {
    // The console's /remember accepts "preference: ...". The chat path did not, so the
    // same phrase stored a different category depending on which interface was used,
    // and the reply read as though a category had been chosen when it had not.
    const runtime = await testRuntime();
    await runtime.chat("remember preference: I stream on Friday nights with OBS");
    const hits = await runtime.memory.search("stream Friday nights", { limit: 3 });
    const stored = hits.find((hit) => hit.value.includes("Friday nights"));
    assert.ok(stored, "the memory is stored");
    assert.equal(stored?.category, "preference");
    assert.ok(!stored?.value.startsWith("preference:"), "the category tag is not kept in the value");
  });

  it("still stores an untagged sentence as a plain fact", async () => {
    const runtime = await testRuntime();
    await runtime.chat("remember that my main game is Squad");
    const hits = await runtime.memory.search("main game Squad", { limit: 3 });
    assert.ok(hits.some((hit) => hit.value.includes("Squad")));
  });

  it("does not treat an unknown prefix as a category", () => {
    const intent = classifyIntent("remember bananas: they are yellow");
    assert.equal(intent?.kind, "remember");
    // "bananas" is not a category, so the old key/value split still applies.
    assert.equal(intent?.slots.category, undefined);
  });
});

describe("agent — catch me up", () => {
  it("classifies 'catch me up' as catchup, ahead of the general status regex", () => {
    assert.equal(classifyIntent("catch me up")?.kind, "catchup");
    assert.equal(classifyIntent("what did I miss")?.kind, "catchup");
    assert.equal(classifyIntent("what's new")?.kind, "catchup");
    assert.equal(classifyIntent("what happened")?.kind, "catchup");
    assert.equal(classifyIntent("what happened while I was away")?.kind, "catchup");
  });

  it("summarises events by category, and drops idle_tick as background noise", async () => {
    // The mission's own example question: "Vesper, catch me up." A catchup reply is
    // built from what the runtime already knows — nothing is fabricated. Every category
    // this test seeds must appear in the reply; idle_tick must not.
    const runtime = await testRuntime();
    runtime.events.emit({
      type: "security.state_unreadable",
      severity: "error",
      title: "State was unreadable on startup",

    });
    runtime.events.emit({
      type: "application.started",
      severity: "info",
      title: "Chrome started",

    });
    runtime.events.emit({
      type: "game.started",
      severity: "info",
      title: "Squad launched",

    });
    runtime.events.emit({
      type: "workspace.switch",
      severity: "info",
      title: "Switched to gaming",

    });
    runtime.events.emit({
      type: "optimizer.state",
      severity: "info",
      title: "Optimizer engaged",

    });
    // Noise the catchup summary must drop.
    for (let i = 0; i < 20; i++) {
      runtime.events.emit({
        type: "lifecycle.idle_tick",
        severity: "info",
        title: "Idle tick",

      });
    }

    const turn = await runtime.chat("catch me up");

    assert.match(turn.reply, /Security notices.*State was unreadable/);
    assert.match(turn.reply, /Applications.*Squad launched/);
    assert.match(turn.reply, /Workspace changes.*Switched to gaming/);
    assert.match(turn.reply, /Optimizer state changes.*Optimizer engaged/);
    // The 20 idle_ticks must not appear as lifecycle titles or as an inflated count.
    // The whole lifecycle badge only counts start/stop/pause, so the digest should read
    // "Lifecycle: 1 start." even though the ring holds 20 idle_ticks plus one start.
    assert.ok(!/idle tick/i.test(turn.reply), "idle_tick events must not appear in the digest");
    assert.match(turn.reply, /Lifecycle: 1 start\./);
    assert.ok(!/Lifecycle:.*21/i.test(turn.reply), "the 20 idle_ticks must not inflate any count");
    assert.match(turn.reply, /workspace .+, \d+ remembered fact/);
  });

  it("reports queued confirmations at the top of the catchup", async () => {
    // A pending confirmation is user-owned business. The mission's rule "confirmation is
    // not authorization" means the catchup must not silently ignore actions the user
    // hasn't answered.
    const runtime = await testRuntime();
    const optimize = await runtime.chat("optimize this");
    assert.ok(optimize.pendingConfirmations.length >= 1);
    const turn = await runtime.chat("catch me up");
    assert.match(turn.reply, /1 action waiting for your confirmation/);
  });

  it("summarises a quiet startup as a short lifecycle line plus context", async () => {
    // A fresh runtime emits a lifecycle.start event on boot. Everything else is quiet.
    // The catchup should report the start and the context, and nothing else — no
    // security notices, no applications, no confirmations, no fabricated news.
    const runtime = await testRuntime();
    const turn = await runtime.chat("catch me up");
    assert.match(turn.reply, /Lifecycle: 1 start/);
    assert.match(turn.reply, /workspace .+, \d+ remembered fact/);
    assert.ok(!/Security notices/.test(turn.reply));
    assert.ok(!/Applications/.test(turn.reply));
    assert.ok(!/waiting for your confirmation/.test(turn.reply));
  });
});

describe("agent — what can you do", () => {
  it("classifies help / what can you do / list tools as capabilities", () => {
    assert.equal(classifyIntent("help")?.kind, "capabilities");
    assert.equal(classifyIntent("help me")?.kind, "capabilities");
    assert.equal(classifyIntent("what can you do")?.kind, "capabilities");
    assert.equal(classifyIntent("what can you do?")?.kind, "capabilities");
    assert.equal(classifyIntent("what are you capable of")?.kind, "capabilities");
    assert.equal(classifyIntent("list your commands")?.kind, "capabilities");
    assert.equal(classifyIntent("list your tools")?.kind, "capabilities");
    assert.equal(classifyIntent("show your capabilities")?.kind, "capabilities");
    assert.equal(classifyIntent("what tools do you have")?.kind, "capabilities");
    assert.equal(classifyIntent("which tools are available")?.kind, "capabilities");
  });

  it("reports the current tool tier counts from the live registry", async () => {
    // The reply is composed from `tools.list(workspace)` and the router — not from a
    // hand-written list that could drift out of date. Every tier that the registry
    // holds should be named, and the sum of tier counts should match the total.
    const runtime = await testRuntime();
    const turn = await runtime.chat("what can you do?");
    const totalMatch = turn.reply.match(/Vesper has (\d+) tool/);
    assert.ok(totalMatch, "tool count line missing");
    const total = Number(totalMatch[1]);
    assert.ok(total > 0);
    // Sum the tier counts the reply itself names.
    const tierSum = [...turn.reply.matchAll(/^ {2}[a-z].*?: (\d+) —/gm)].reduce(
      (acc, m) => acc + Number(m[1]),
      0,
    );
    assert.equal(tierSum, total, `tier counts (${tierSum}) do not sum to the total (${total})`);
    // Never-autonomous tools are load-bearing to the safety story; must be named.
    assert.match(turn.reply, /never autonomous.*disk_wipe|disk_wipe.*never autonomous/);
  });

  it("does not advertise the test backend as a reachable model", async () => {
    // The `echo` provider exists so tests can drive the agent without a real model.
    // Announcing it as "a local model backend" would dilute the truthful
    // "no backend reachable" reply the mission depends on.
    const runtime = await testRuntime();
    const turn = await runtime.chat("what can you do");
    assert.ok(!/echo/i.test(turn.reply), `test backend leaked into capabilities: ${turn.reply}`);
    assert.match(turn.reply, /No local model backend is reachable|backends reachable:/);
  });

  it("names the current workspace's toolset, not another workspace's", async () => {
    // A tool registered only for one workspace must appear when asked from that
    // workspace, and not from another. This is what `tools.list(workspace.id)` is
    // for; mutation-removing the workspace filter would show every tool everywhere.
    // No production tool is currently workspace-scoped, so register one here — the
    // load-bearingness of the filter has to be provable by test, not by inspection.
    const runtime = await testRuntime();
    runtime.tools.register(
      {
        name: "gaming_only_tool",
        description: "Only visible in the gaming workspace",
        permission: "read",
        parameters: { type: "object", properties: {}, required: [] },
        workspaces: ["gaming"],
      },
      async () => ({ ok: true, epistemic: "checked", summary: "ok" }),
    );

    const general = await runtime.chat("what can you do?");
    const generalCount = Number(general.reply.match(/Vesper has (\d+) tool/)?.[1]);

    await runtime.chat("switch to gaming");
    const gaming = await runtime.chat("what can you do?");
    assert.match(gaming.reply, /Gaming workspace/);
    const gamingCount = Number(gaming.reply.match(/Vesper has (\d+) tool/)?.[1]);

    // Removing the workspace filter would make both counts equal — the workspace-scoped
    // tool would be visible from General too. The gap of exactly 1 is what the filter
    // is meant to produce.
    assert.equal(gamingCount, generalCount + 1, `gaming (${gamingCount}) should have one more tool than general (${generalCount})`);
  });
});
