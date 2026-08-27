import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { recordingProvider } from "./lib.ts";
const rec = recordingProvider([]);
const runtime = await testRuntime({ providers: [rec.provider] });
await runtime.knowledge.reindex();
console.log("indexed:", JSON.stringify(runtime.knowledge.lastIndexStats()));
const queries = ["how does the optimizer work", "what is my gpu temperature", "explain the benchmark harness", "what did I write about voice", "who owns the mortis canon"];
for (const q of queries) {
  const hits = runtime.knowledge.search(q, { workspaceId: "general", limit: 4 });
  console.log(`\nQ ${JSON.stringify(q)}\n  top hits: ${hits.map((h) => `${h.path}(${h.score.toFixed(2)})`).join(", ")}`);
}
const turn = await runtime.chat("what is my gpu temperature trend across the week");
const sys = rec.systemPrompts[0] ?? "";
const i = sys.indexOf("Knowledge hits:");
console.log("\n---- knowledge block delivered to the model ----");
console.log(JSON.stringify(sys.slice(i, i + 1400)));
console.log("---- security events ----");
const evs = turn.events.filter((e) => e.type === "security.untrusted_content");
console.log(evs.length ? evs.map((e) => `${e.severity} ${e.title}`).join("\n") : "(NONE)");
await runtime.stop();
