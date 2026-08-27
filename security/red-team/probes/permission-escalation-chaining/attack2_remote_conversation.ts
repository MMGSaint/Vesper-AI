// A remote device talks to Vesper only via conversation (a tool-calling loop).
// Can it chain that into filesystem / trust-admin / cross-scope reads on the HOST?
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { isClientError } from "../../../../src/vesper/client/protocol.ts";
import { scriptSequence } from "./lib.ts";

async function run(label: string, trust: "trusted" | "restricted", scopes: any[], attempts: string[][]) {
  const provider = scriptSequence(attempts.map((batch) => batch.map((name) => ({ name, arguments: argFor(name) }))));
  const runtime = await testRuntime({ providers: [provider] });
  const peer = await enrolCompanion(runtime, { name: "phone", trust });
  const gw = createClientGateway(runtime);
  const session = await gw.issueSession({ deviceId: peer.deviceId, scopes });
  if (isClientError(session)) {
    console.log(label, "session error", session.detail);
    await runtime.stop();
    return;
  }
  const turn = await gw.converse(session.token, "do everything");
  if (isClientError(turn)) {
    console.log(label, "converse error", turn.detail);
    await runtime.stop();
    return;
  }
  console.log(`\n== ${label} (trust=${trust}, scopes=${scopes.join("|")}) ==`);
  for (const c of turn.toolCalls) {
    console.log(
      "  ", c.toolName.padEnd(18),
      "allowed=", c.decision.allowed,
      "ok=", c.result?.ok ?? "(not run)",
      "|", (c.result?.summary ?? c.decision.reason).slice(0, 80),
    );
  }
  await runtime.stop();
}

function argFor(name: string): Record<string, unknown> {
  switch (name) {
    case "fs_read": return { path: "notes/anything" };
    case "fs_write": return { path: "notes/x.txt", content: "x" };
    case "memory_search": return { query: "communication" };
    case "memory_remember": return { key: "k", value: "v" };
    case "knowledge_search": return { query: "vesper" };
    case "knowledge_register": return { id: "x", name: "x", root: "notes" };
    case "device_trust": return { deviceId: "self", trust: "trusted" };
    case "workspace_switch": return { name: "mortis" };
    case "system_info": return {};
    case "diagnostics_report": return {};
    case "task_create": return { description: "run something" };
    default: return {};
  }
}

const all = [
  "fs_read", "fs_write", "memory_search", "memory_remember", "knowledge_search",
  "knowledge_register", "device_trust", "workspace_switch", "system_info",
  "diagnostics_report", "task_create",
];

// Trusted device, but session only holds `conversation` (no memory/knowledge scopes).
await run("trusted+conversation-only", "trusted", ["conversation"], [all]);
// Trusted device with the broadest companion scopes it could ever be issued.
await run("trusted+all-scopes", "trusted",
  ["conversation", "memory.read", "memory.write", "knowledge.read", "notifications", "operator.confirm"], [all]);
// Restricted (portable / not-yet-promoted) device.
await run("restricted", "restricted",
  ["conversation", "memory.read", "memory.write", "knowledge.read", "operator.confirm"], [all]);
