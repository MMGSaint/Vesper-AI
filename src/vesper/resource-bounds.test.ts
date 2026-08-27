import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrolCompanion, testRuntime } from "./test-helpers.ts";
import { createClientGateway } from "./client/gateway.ts";
import { MAX_REMOTE_MESSAGE_CHARS } from "./client/gateway.ts";
import { MAX_PENDING_CONFIRMATIONS } from "./tools/registry.ts";
import { MAX_MEMORY_VALUE_CHARS } from "./memory/store.ts";
import { MAX_RETRIEVAL_QUERY_CHARS, MAX_TOOL_CALLS_PER_ROUND } from "./agent.ts";
import type { CompletionRequest, ModelToolCall } from "./types.ts";

/**
 * Vesper is a single-threaded process holding the user's files, memory and device keys.
 * Anything an attacker can make it allocate or iterate without bound is authority of a
 * kind: a host that is out of memory, or blocked for a minute, is a host that is not
 * enforcing anything.
 *
 * The threat model here is the standing one — the model may be jailbroken or
 * prompt-injected, and a companion device may be the lowest trust class Vesper admits.
 * Both choose sizes and counts, so both must meet a bound that does not depend on them
 * behaving.
 *
 * Every test asserts on the *observable* consequence (queue size, wall clock, whether a
 * value reached the store), not on a returned message.
 */

/** A model that asks for `count` confirm-tier tool calls in every round. */
function floods(count: number, argSize = 16) {
  return {
    id: "flood",
    kind: "local" as const,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "flood" };
    },
    async complete(request: CompletionRequest, model: string) {
      const toolCalls: ModelToolCall[] = Array.from({ length: count }, (_, i) => ({
        id: `c${i}`,
        name: "app_close",
        arguments: { name: `app-${i}-${"x".repeat(argSize)}` } as never,
      }));
      return { text: "", toolCalls, providerId: "flood", model, role: request.role };
    },
  };
}

describe("the confirmation queue is bounded", () => {
  it("holds no more than the cap however many calls one turn asks for", async () => {
    // Before the cap: one turn queued 4,000 entries (500 calls x 8 rounds), the queue was
    // re-serialised to disk after every turn, and a few more turns reached a V8 heap OOM.
    const runtime = await testRuntime({ providers: [floods(500)] });
    const turn = await runtime.chat("close everything");
    assert.ok(
      runtime.confirmations.size <= MAX_PENDING_CONFIRMATIONS,
      `queue grew to ${runtime.confirmations.size}`,
    );
    assert.ok(
      turn.pendingConfirmations.length <= MAX_PENDING_CONFIRMATIONS,
      "the turn surfaced more pending confirmations than the cap",
    );

    // And it stays bounded across turns, which is where the growth actually was.
    await runtime.chat("again");
    await runtime.chat("again");
    assert.ok(
      runtime.confirmations.size <= MAX_PENDING_CONFIRMATIONS,
      `queue grew to ${runtime.confirmations.size} over three turns`,
    );
    await runtime.stop();
  });

  it("refuses the request past the cap, whatever route queued the earlier ones", async () => {
    // Driven straight at the registry rather than through a turn, because the per-round
    // tool-call cap would otherwise stop the flood before this cap was ever consulted —
    // and a bound that is never reached is a bound nobody has tested.
    const runtime = await testRuntime();
    const queued: string[] = [];
    let refused = 0;
    for (let i = 0; i < MAX_PENDING_CONFIRMATIONS + 12; i += 1) {
      const record = await runtime.tools.invoke({
        name: "app_close",
        args: { name: `app-${i}` },
        workspaceId: "general",
      });
      if (record.confirmationId) queued.push(record.confirmationId);
      else refused += 1;
    }
    assert.equal(
      runtime.confirmations.size,
      MAX_PENDING_CONFIRMATIONS,
      "the queue grew past its cap",
    );
    assert.equal(queued.length, MAX_PENDING_CONFIRMATIONS);
    assert.equal(refused, 12, "requests past the cap were not refused");
    await runtime.stop();
  });

  it("refuses rather than evicting, so a real pending request is never flushed out", async () => {
    // Eviction would turn a denial-of-service into a silent authorization change: the
    // action the user was about to approve would simply vanish.
    const runtime = await testRuntime({ providers: [floods(500)] });
    const first = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "the-one-that-matters" },
      workspaceId: "general",
    });
    const mine = first.confirmationId;
    assert.ok(mine, "the first request was not queued at all");

    for (let i = 0; i < MAX_PENDING_CONFIRMATIONS + 20; i += 1) {
      await runtime.tools.invoke({
        name: "app_close",
        args: { name: `filler-${i}` },
        workspaceId: "general",
      });
    }
    assert.equal(
      runtime.confirmations.has(mine),
      true,
      "a flood pushed the genuine pending confirmation out of the queue",
    );
    await runtime.stop();
  });

  it("refuses a confirmation whose arguments are absurdly large", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "x".repeat(300_000) },
      workspaceId: "general",
    });
    assert.equal(record.confirmationId, undefined, "an oversized request was queued");
    assert.equal(record.result?.ok, false);
    assert.equal(runtime.confirmations.size, 0);
    await runtime.stop();
  });

  it("still queues an ordinary confirmation and still runs it when approved", async () => {
    // Narrowing, not severing.
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "discord" },
      workspaceId: "general",
    });
    assert.ok(record.confirmationId, "an ordinary request stopped being queued");
    const approved = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "discord" },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(approved.result?.ok, true, approved.result?.summary);
    await runtime.stop();
  });

  it("expires a confirmation nobody answered, and only that one", async () => {
    const runtime = await testRuntime();
    const fresh = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "discord" },
      workspaceId: "general",
    });
    const stale = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "steam" },
      workspaceId: "general",
    });
    const staleEntry = runtime.confirmations.get(stale.confirmationId!)!;
    staleEntry.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    runtime.tools.sweepExpiredConfirmations();
    assert.equal(runtime.confirmations.has(stale.confirmationId!), false, "a day-old confirmation survived");
    assert.equal(runtime.confirmations.has(fresh.confirmationId!), true, "a fresh confirmation was swept");
    await runtime.stop();
  });
});

describe("a remote message cannot be arbitrarily large", () => {
  it("refuses an oversized message from the lowest trust class, quickly", async () => {
    // 10.9 MiB from a restricted companion blocked the whole host for 84 seconds in
    // knowledge retrieval. `knowledge.read` is inside RESTRICTED_COMPANION_SCOPES, so
    // this was reachable by the trust class Vesper says it cannot vouch for.
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const phone = await enrolCompanion(runtime, { name: "phone", trust: "restricted" });
    const session = await gateway.issueSession({
      deviceId: phone.deviceId,
      deviceLabel: "phone",
      scopes: ["status", "conversation", "knowledge.read"],
    });
    if ("ok" in session) throw new Error(session.detail);

    const started = Date.now();
    const result = await gateway.converse(session.token, "a ".repeat(3_000_000));
    const elapsed = Date.now() - started;

    assert.ok("ok" in result && result.ok === false, "a 6 MB message was accepted");
    assert.equal(result.code, "INVALID");
    assert.ok(elapsed < 5000, `the refusal itself took ${elapsed}ms`);

    // Narrowing, not severing: an ordinary message still works on the same session.
    const ordinary = await gateway.converse(session.token, "what is running?");
    assert.equal("ok" in ordinary, false, "an ordinary remote message stopped working");
    await runtime.stop();
  });

  it("accepts a long-but-legitimate message", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const phone = await enrolCompanion(runtime, { name: "phone" });
    const session = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone" });
    if ("ok" in session) throw new Error(session.detail);
    const long = "Here are my notes about the stream setup. ".repeat(
      Math.floor((MAX_REMOTE_MESSAGE_CHARS - 100) / 42),
    );
    assert.ok(long.length < MAX_REMOTE_MESSAGE_CHARS);
    const result = await gateway.converse(session.token, long);
    assert.equal("ok" in result, false, "a message inside the limit was refused");
    await runtime.stop();
  });
});

describe("what is stored is bounded, because storage is the cost of every later turn", () => {
  it("refuses an enormous memory value instead of storing it", async () => {
    // One planted 18 MiB entry made an ordinary 53-character question take 1.7 seconds,
    // and the heap grew on every repeat.
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "memory_remember",
      args: { key: "fat", value: "x".repeat(2_000_000), category: "fact" },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.result?.ok, false, "an enormous memory was stored");
    const found = await runtime.memory.search("fat", { scope: "all" });
    assert.equal(
      found.some((entry) => entry.key === "fat"),
      false,
      "the oversized value reached the store anyway",
    );
    await runtime.stop();
  });

  it("still stores an ordinary memory", async () => {
    const runtime = await testRuntime();
    const value = "Prefers dark mode, plays VRChat on Thursdays, dislikes autoplaying video.";
    assert.ok(value.length < MAX_MEMORY_VALUE_CHARS);
    const record = await runtime.tools.invoke({
      name: "memory_remember",
      args: { key: "preferences", value, category: "preference" },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.result?.ok, true, record.result?.summary);
    await runtime.stop();
  });
});

describe("retrieval cost does not scale with the length of the question", () => {
  /**
   * Asserted on the query the retrieval layer is *given*, not on the wall clock.
   *
   * A timing assertion here was not load-bearing: with the bound removed the test still
   * passed, because a test-sized corpus is not big enough to be slow. The bound is real
   * — the reproduction blocked the host for 84 seconds against 202 documents — but a
   * timing threshold small enough to catch it is a timing threshold that will flake.
   * What is deterministic is that neither store ever receives more than the bound.
   */
  function recordsQueries(runtime: Awaited<ReturnType<typeof testRuntime>>) {
    const seen: string[] = [];
    const knowledge = runtime.knowledge as unknown as {
      searchAsync: (q: string, o?: unknown) => Promise<unknown[]>;
    };
    const memory = runtime.memory as unknown as {
      search: (q: string, o?: unknown) => Promise<unknown[]>;
    };
    const realKnowledge = knowledge.searchAsync.bind(runtime.knowledge);
    const realMemory = memory.search.bind(runtime.memory);
    knowledge.searchAsync = async (query, options) => {
      seen.push(query);
      return realKnowledge(query, options as never);
    };
    memory.search = async (query, options) => {
      seen.push(query);
      return realMemory(query, options as never);
    };
    return seen;
  }

  it("never hands retrieval more of the message than the bound", async () => {
    // The local path has no gateway to refuse anything, so the bound has to be on the
    // query the retrieval layer is given.
    const runtime = await testRuntime();
    const seen = recordsQueries(runtime);
    await runtime.chat("capture card ".repeat(40_000));
    assert.ok(seen.length > 0, "retrieval was never called, so this proves nothing");
    for (const query of seen) {
      assert.ok(
        query.length <= MAX_RETRIEVAL_QUERY_CHARS,
        `retrieval was handed ${query.length} characters`,
      );
    }
    await runtime.stop();
  });

  it("still hands it the whole of an ordinary question", async () => {
    const runtime = await testRuntime();
    const seen = recordsQueries(runtime);
    // Phrased so it reaches the model path: "what do you know about X" is answered by a
    // deterministic intent that never calls retrieval, and asserting against that would
    // have measured the wrong path.
    const question = "capture card and encoder settings for the stream tonight";
    await runtime.chat(question);
    assert.ok(seen.includes(question), "an ordinary question was truncated before retrieval");
    await runtime.stop();
  });
});

describe("one round of tool calls is bounded", () => {
  it("executes no more than the per-round cap however many the model asks for", async () => {
    // The queue cap would eventually stop a flood, but only after every one of the calls
    // had been validated, gated and recorded. A model asking for hundreds of calls in a
    // single round is malfunctioning or hostile either way.
    const runtime = await testRuntime({ providers: [floods(400)] });
    const turn = await runtime.chat("close everything");
    assert.ok(
      turn.toolCalls.length <= MAX_TOOL_CALLS_PER_ROUND * 2,
      `one turn executed ${turn.toolCalls.length} tool calls`,
    );
    await runtime.stop();
  });

  it("still runs every call of an ordinary multi-call round", async () => {
    const runtime = await testRuntime({ providers: [floods(3)] });
    const turn = await runtime.chat("close discord and steam");
    assert.equal(turn.toolCalls.length, 3, "an ordinary round was truncated");
    await runtime.stop();
  });
});
