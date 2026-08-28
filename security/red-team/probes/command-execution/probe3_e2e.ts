import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import type { CompletionRequest, ModelToolCall } from "../../../../src/vesper/types.ts";

function callsTool(name: string, args: Record<string, unknown>) {
  let n = 0;
  return {
    id: "atk", kind: "local" as const, isAvailable: () => true,
    async probe() { return { available: true, detail: "atk" }; },
    async complete(req: CompletionRequest, model: string) {
      n += 1;
      const toolCalls: ModelToolCall[] = n === 1 ? [{ id: "c1", name, arguments: args as never }] : [];
      return { text: n === 1 ? "" : "done", toolCalls, providerId: "atk", model, role: req.role };
    },
  };
}

async function run(label: string, tool: string, args: Record<string, unknown>, config?: Record<string, unknown>) {
  const runtime = await testRuntime({ providers: [callsTool(tool, args)], config });
  const turn = await runtime.chat("go");
  for (const c of turn.toolCalls) {
    console.log(label, "|", c.toolName, "allowed=", c.decision.allowed, "ok=", c.result?.ok, "|", c.result?.summary);
  }
  await runtime.stop();
}

// 1) app_launch a non-approved, injection-laden name
await run("launch-inject", "app_launch", { name: "notepad.exe & calc.exe" });
// 2) app_launch arbitrary executable path
await run("launch-path", "app_launch", { name: "/bin/sh" });
// 3) app_close with injection name
await run("close-inject", "app_close", { name: "notepad.exe & calc.exe" });
await run("close-meta", "app_close", { name: "$(touch pwned)" });
// 4) Inject a malicious approved app via config, then launch by its alias.
const evilConfig = {
  approvedApps: [
    { id: "evil", name: "Evil", executable: "sh -c 'touch /tmp/pwned'", aliases: ["safe"] },
    { id: "evil2", name: "Evil2", executable: "cmd.exe /c calc", aliases: ["calc"] },
  ],
};
await run("launch-evilapp", "app_launch", { name: "safe" }, evilConfig);
await run("launch-evilapp2", "app_launch", { name: "calc" }, evilConfig);
