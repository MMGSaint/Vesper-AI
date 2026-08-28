/**
 * Serialization battery against the LIVE tool-call boundary.
 * A scripted provider emits attacker-chosen tool calls; we observe what the
 * deterministic layer (validate -> gate -> remote narrowing -> handler) does.
 */
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import type { CompletionRequest, ModelToolCall, JsonObject } from "../../../../src/vesper/types.ts";

function attacker(calls: ModelToolCall[]) {
  let n = 0;
  return {
    id: "atk", kind: "local" as const, isAvailable: () => true,
    async probe() { return { available: true, detail: "atk" }; },
    async complete(req: CompletionRequest, model: string) {
      n += 1;
      return { text: n === 1 ? "" : "done", toolCalls: n === 1 ? calls : [], providerId: "atk", model, role: req.role };
    },
  };
}

type Case = { label: string; tool: string; args: JsonObject };

const cases: Case[] = [
  { label: "A1 __proto__ own-key in args", tool: "fs_read", args: JSON.parse('{"path":"notes","__proto__":{"confirmed":true}}') },
  { label: "A2 constructor key", tool: "fs_read", args: JSON.parse('{"path":"notes","constructor":{"prototype":{"confirmed":true}}}') },
  { label: "A3 prototype-chain key toString", tool: "fs_read", args: JSON.parse('{"path":"notes","toString":"x"}') },
  { label: "A4 prototype-chain key valueOf", tool: "system_info", args: JSON.parse('{"valueOf":"x"}') },
  { label: "A5 hasOwnProperty key", tool: "system_info", args: JSON.parse('{"hasOwnProperty":"x"}') },
  { label: "A6 enum: numeric that stringifies to a member", tool: "set_scenario", args: { scenario: 0 as never } },
  { label: "A7 enum: unknown member", tool: "set_scenario", args: { scenario: "wipe" } },
  { label: "A8 enum: array whose String() is a member", tool: "set_scenario", args: { scenario: ["gaming"] as never } },
  { label: "A9 required missing", tool: "fs_read", args: {} },
  { label: "A10 required null", tool: "fs_read", args: { path: null as never } },
  { label: "A11 wrong type number for string", tool: "fs_read", args: { path: 123 as never } },
  { label: "A12 numeric string coercion", tool: "events_recent", args: { limit: "5" as never } },
  { label: "A13 number Infinity via string", tool: "events_recent", args: { limit: "1e999" as never } },
  { label: "A14 number hex string", tool: "events_recent", args: { limit: "0x10" as never } },
  { label: "A15 negative number", tool: "events_recent", args: { limit: -1 } },
  { label: "A16 NaN literal", tool: "events_recent", args: { limit: Number.NaN as never } },
  { label: "A17 unknown extra key", tool: "fs_read", args: { path: "notes", permission: "safe", confirmed: true } as never },
  { label: "A18 unknown tool name", tool: "fs_read_", args: { path: "notes" } },
  { label: "A19 tool name w/ trailing space", tool: "fs_read ", args: { path: "notes" } },
  { label: "A20 never-tool direct", tool: "disk_wipe", args: {} },
  { label: "A21 confirm-tool direct (fs_write)", tool: "fs_write", args: { path: "notes/x.txt", content: "hi" } },
  { label: "A22 deep nesting 2000 in array param", tool: "task_create", args: JSON.parse('{"description":"d","requiredCapabilities":' + "[".repeat(200) + "]".repeat(200) + '}') },
  { label: "A23 huge string 2MB", tool: "fs_read", args: { path: "n".repeat(2_000_000) } },
  { label: "A24 array of 100k in array param", tool: "task_create", args: { description: "d", requiredCapabilities: Array.from({ length: 100000 }, (_, i) => `c${i}`) } },
];

for (const c of cases) {
  const runtime = await testRuntime({ providers: [attacker([{ id: "c1", name: c.tool, arguments: c.args }])] });
  try {
    const turn = await runtime.chat("go");
    const rec = turn.toolCalls[0];
    const line = rec
      ? `allowed=${rec.decision.allowed} level=${rec.decision.level} confirm=${rec.decision.requiresConfirmation} ok=${rec.result?.ok ?? "-"} :: ${String(rec.result?.summary ?? rec.decision.reason).slice(0, 110)}`
      : "no tool call recorded";
    console.log(`${c.label.padEnd(44)} ${line}`);
  } catch (e) {
    console.log(`${c.label.padEnd(44)} THREW: ${(e as Error).message.slice(0, 120)}`);
  }
  console.log(`${"".padEnd(44)} Object.prototype.confirmed=${(({} as never as Record<string, unknown>).confirmed) === true ? "POLLUTED" : "clean"}`);
  await runtime.stop();
}
