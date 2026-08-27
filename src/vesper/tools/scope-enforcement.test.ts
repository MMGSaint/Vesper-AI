import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrolCompanion, testRuntime } from "../test-helpers.ts";
import { createClientGateway } from "../client/gateway.ts";
import { isClientError, type ClientScope } from "../client/protocol.ts";
import type { ChatMessage, CompletionRequest, ModelToolCall } from "../types.ts";

/**
 * Scopes govern gateway methods. Tools are not gateway methods, and neither is the
 * retrieval that fills the prompt — so a device holding only `conversation` reached
 * exactly the data its missing scopes describe, by two routes that never touched the
 * method it was refused.
 *
 * These tests assert against the bytes handed to the provider and the results handed
 * back, because that is where the data actually goes.
 */

const PIN = "my bank pin is 4417";
const PHRASE = "recovery phrase: correct horse battery staple";

function scripted(toolName?: string, args: Record<string, unknown> = {}) {
  const seen: ChatMessage[][] = [];
  let n = 0;
  return {
    seen,
    provider: {
      id: "scripted",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "scripted" };
      },
      async complete(request: CompletionRequest, model: string) {
        seen.push(request.messages);
        n += 1;
        const toolCalls: ModelToolCall[] =
          toolName && n === 1 ? [{ id: "c1", name: toolName, arguments: args as never }] : [];
        return {
          text: toolCalls.length ? "" : "done",
          toolCalls,
          providerId: "scripted",
          model,
          role: request.role,
        };
      },
    },
  };
}

/** A runtime holding one private memory and one private indexed document. */
async function loaded(toolName?: string, args: Record<string, unknown> = {}) {
  const base = await mkdtemp(join(tmpdir(), "vesper-scope-"));
  const approved = join(base, "notes");
  await mkdir(approved, { recursive: true });
  await writeFile(join(approved, "private.md"), PHRASE, "utf8");

  const { seen, provider } = scripted(toolName, args);
  const runtime = await testRuntime({ providers: [provider], config: { approvedRoots: [approved] } });
  await runtime.memory.remember({ category: "fact", key: "bank pin", value: PIN, source: "user" });
  runtime.knowledge.registerSource({ id: "notes", name: "notes", roots: [approved], enabled: true });
  await runtime.knowledge.reindex();
  return { runtime, gateway: createClientGateway(runtime), seen };
}

async function phoneSession(
  runtime: Awaited<ReturnType<typeof loaded>>["runtime"],
  gateway: ReturnType<typeof createClientGateway>,
  scopes: ClientScope[],
) {
  const phone = await enrolCompanion(runtime, { name: "phone" });
  const session = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes });
  if (isClientError(session)) throw new Error(session.detail);
  return session;
}

describe("a scope-governed tool answers to scopes wherever it is reached from", () => {
  for (const [tool, args, scope, secret] of [
    ["memory_search", { query: "bank pin" }, "memory.read", "4417"],
    ["knowledge_search", { query: "recovery phrase" }, "knowledge.read", "correct horse battery staple"],
  ] as const) {
    it(`refuses ${tool} in a conversation when the session lacks ${scope}`, async () => {
      const { runtime, gateway } = await loaded(tool, args);
      const session = await phoneSession(runtime, gateway, ["status", "conversation"]);

      const turn = await gateway.converse(session.token, "go");
      if (isClientError(turn)) throw new Error(turn.detail);
      const record = turn.toolCalls.find((call) => call.toolName === tool);
      assert.equal(record?.result?.ok, false, `${tool} ran without ${scope}`);
      assert.match(record?.result?.summary ?? "", new RegExp(scope.replace(".", "\\.")));
      assert.equal(
        JSON.stringify(record?.result ?? {}).includes(secret),
        false,
        "the refusal still returned the protected value",
      );
      await runtime.stop();
    });
  }

  it("refuses memory_remember in a conversation when the session lacks memory.write", async () => {
    const { runtime, gateway } = await loaded("memory_remember", {
      key: "planted",
      value: "planted by a remote device",
      category: "fact",
    });
    const session = await phoneSession(runtime, gateway, ["status", "conversation"]);
    const turn = await gateway.converse(session.token, "go");
    if (isClientError(turn)) throw new Error(turn.detail);
    assert.equal(turn.toolCalls.find((c) => c.toolName === "memory_remember")?.result?.ok, false);
    const stored = await runtime.memory.search("planted", { scope: "all" });
    assert.equal(stored.some((e) => e.key === "planted"), false, "the write landed anyway");
    await runtime.stop();
  });

  it("still allows the tool once the session holds the scope", async () => {
    // The control must narrow, not sever.
    const { runtime, gateway } = await loaded("memory_search", { query: "bank pin" });
    const session = await phoneSession(runtime, gateway, ["status", "conversation", "memory.read"]);
    const turn = await gateway.converse(session.token, "go");
    if (isClientError(turn)) throw new Error(turn.detail);
    assert.equal(turn.toolCalls.find((c) => c.toolName === "memory_search")?.result?.ok, true);
    await runtime.stop();
  });

  it("keeps knowledge-source registration at the machine", async () => {
    // Choosing which directories Vesper reads is filesystem policy, and a remote device
    // that could widen it would have reached the authority it is never granted directly.
    const { runtime, gateway } = await loaded("knowledge_register", {
      id: "evil",
      name: "evil",
      root: "/etc",
    });
    const session = await phoneSession(runtime, gateway, [
      "status",
      "conversation",
      "knowledge.read",
    ]);
    const turn = await gateway.converse(session.token, "go");
    if (isClientError(turn)) throw new Error(turn.detail);
    const record = turn.toolCalls.find((c) => c.toolName === "knowledge_register");
    assert.equal(record?.result?.ok, false);
    assert.match(record?.result?.summary ?? "", /only be run at the machine/);
    await runtime.stop();
  });
});

describe("retrieval into the prompt answers to the same scopes", () => {
  it("does not hand stored memory to a session that may not read it", async () => {
    // The tool gate would be the front door on a building with no back wall: the model
    // is handed the same records every turn, and the session steers what is retrieved.
    const { runtime, gateway, seen } = await loaded();
    const session = await phoneSession(runtime, gateway, ["status", "conversation"]);
    await gateway.converse(session.token, "tell me about my bank pin");
    const system = seen.at(-1)?.find((m) => m.role === "system")?.content ?? "";
    assert.ok(system.length > 0, "the turn reached the provider");
    assert.equal(system.includes("4417"), false, "private memory was placed in the context");
    await runtime.stop();
  });

  it("does not hand indexed documents to a session that may not read them", async () => {
    const { runtime, gateway, seen } = await loaded();
    const session = await phoneSession(runtime, gateway, ["status", "conversation"]);
    await gateway.converse(session.token, "what is my recovery phrase");
    const system = seen.at(-1)?.find((m) => m.role === "system")?.content ?? "";
    assert.equal(
      system.includes("correct horse battery staple"),
      false,
      "indexed file contents were placed in the context",
    );
    await runtime.stop();
  });

  it("says the data is unavailable rather than claiming there was none", async () => {
    // "No relevant memory hits" would be a false statement to Vesper's own model, and
    // an invitation to fill the gap by guessing.
    const { runtime, gateway, seen } = await loaded();
    const session = await phoneSession(runtime, gateway, ["status", "conversation"]);
    await gateway.converse(session.token, "tell me about my bank pin");
    const system = seen.at(-1)?.find((m) => m.role === "system")?.content ?? "";
    assert.match(system, /not readable by this session/);
    assert.equal(system.includes("No relevant memory hits"), false);
    await runtime.stop();
  });

  it("still retrieves for a session that holds the scopes", async () => {
    const { runtime, gateway, seen } = await loaded();
    const session = await phoneSession(runtime, gateway, [
      "status",
      "conversation",
      "memory.read",
      "knowledge.read",
    ]);
    await gateway.converse(session.token, "tell me about my bank pin and recovery phrase");
    const system = seen.at(-1)?.find((m) => m.role === "system")?.content ?? "";
    assert.equal(system.includes("4417"), true, "a scoped session lost its own retrieval");
    await runtime.stop();
  });

  it("still retrieves for the person at the machine", async () => {
    const { runtime, seen } = await loaded();
    await runtime.chat("tell me about my bank pin and recovery phrase");
    const system = seen.at(-1)?.find((m) => m.role === "system")?.content ?? "";
    assert.equal(system.includes("4417"), true, "local retrieval was broken by a remote control");
    assert.equal(system.includes("correct horse battery staple"), true);
    await runtime.stop();
  });
});
