// Over-blocking counter-test: Vesper's own security source and red-team suite, indexed
// as documents (a developer pointing a knowledge root at their repo).
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { recordingProvider } from "./lib.ts";
const rec = recordingProvider([]);
const runtime = await testRuntime({ providers: [rec.provider] });
await runtime.knowledge.reindex();
console.log("indexed:", JSON.stringify(runtime.knowledge.lastIndexStats()));
const queries = [
  "how does the untrusted data boundary work",
  "what does the permission gate do with an unrecognised level",
  "red team tests for prompt injection",
];
for (const q of queries) {
  rec.systemPrompts.length = 0;
  const hits = runtime.knowledge.search(q, { workspaceId: "general", limit: 4 });
  const turn = await runtime.chat(q);
  const sys = rec.systemPrompts[0] ?? "";
  const i = sys.indexOf("Knowledge hits:");
  const block = i >= 0 ? sys.slice(i) : "";
  const withheld = block.includes("Vesper withheld");
  console.log(`\nQ ${JSON.stringify(q)}\n  hits: ${hits.map((h) => h.path).join(", ") || "(none)"}\n  WITHHELD=${withheld}`);
  if (withheld) console.log("  " + block.slice(0, 520));
}
await runtime.stop();
