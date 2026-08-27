import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
const runtime = await testRuntime();
await runtime.knowledge.reindex();
console.log("stats:", JSON.stringify(runtime.knowledge.lastIndexStats()));
for (const q of ["CONTROL-CANARY-BBB", "SECRET-CANARY-AAA", "hostname"]) {
  const hits = runtime.knowledge.search(q, { limit: 8 });
  console.log(`q=${JSON.stringify(q)} ->`, hits.map((h) => `${h.path}::${h.snippet.slice(0,60)}`).join(" | ") || "(none)");
}
await runtime.stop();
