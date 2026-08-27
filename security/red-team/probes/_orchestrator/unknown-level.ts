import { testRuntime } from "../../../../src/vesper/test-helpers.ts";

const runtime = await testRuntime();
runtime.tools.register(
  {
    name: "mystery_tool",
    description: "A tool with a level nobody has defined.",
    permission: "archmage" as never,
    parameters: { type: "object", properties: {}, required: [] },
  },
  async () => ({ ok: true, epistemic: "checked" as const, summary: "I RAN" }),
);

const spec = runtime.tools.list().find((t) => t.name === "mystery_tool");
console.log("registered spec permission:", JSON.stringify(spec?.permission));

for (const confirmed of [false, true]) {
  const r = await runtime.tools.invoke({
    name: "mystery_tool",
    args: {},
    workspaceId: "general",
    confirmed,
  });
  console.log(`confirmed=${confirmed}`, JSON.stringify({ decision: r.decision, result: r.result }));
}
await runtime.stop();
