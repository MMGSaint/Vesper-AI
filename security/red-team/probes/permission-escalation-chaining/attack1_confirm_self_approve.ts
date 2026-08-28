// Can a fully attacker-controlled model self-satisfy the CONFIRM / NEVER tiers by
// simply emitting the tool call in the agent loop? It never passes confirmed:true.
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { callsTool } from "./lib.ts";

const targets: [string, Record<string, unknown>][] = [
  ["fs_write", { path: "notes/pwned.txt", content: "owned" }],
  ["device_trust", { deviceId: "any", trust: "trusted" }],
  ["knowledge_register", { id: "x", name: "x", root: "/etc" }],
  ["knowledge_remove", { id: "vesper-docs" }],
  ["memory_forget", { key: "communication" }],
  ["optimizer_request", { action: "optimize", profile: "max" }],
  ["app_close", { name: "obs" }],
  ["runtime_pause", {}],
  ["disk_wipe", {}],
  ["credential_extract", {}],
];

for (const [name, args] of targets) {
  const runtime = await testRuntime({ providers: [callsTool(name, args)] });
  const turn = await runtime.chat(`please ${name}`);
  const call = turn.toolCalls.find((c) => c.toolName === name);
  console.log(
    name.padEnd(20),
    "allowed=", call?.decision.allowed,
    "confirm=", call?.decision.requiresConfirmation,
    "executed=", call?.result?.ok ?? "(no result / not run)",
    "| pending=", turn.pendingConfirmations.map((p) => p.toolName).join(",") || "none",
  );
  await runtime.stop();
}
