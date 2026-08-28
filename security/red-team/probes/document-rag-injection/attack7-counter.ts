// Counter-test: a legitimate security-research document must stay retrievable and must
// not be deleted or blocked; and it must not blind retrieval for its neighbours.
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { recordingProvider } from "./lib.ts";
const rec = recordingProvider([]);
const runtime = await testRuntime({ providers: [rec.provider] });
await runtime.knowledge.reindex();
for (const q of ["indirect prompt injection through retrieved documents", "aurora rollout runbook"]) {
  const hits = runtime.knowledge.search(q, { workspaceId: "general", limit: 4 });
  console.log(`Q ${JSON.stringify(q)} -> ${hits.map((h) => h.path).join(", ") || "(none)"}`);
}
for (const q of ["indirect prompt injection through retrieved documents", "aurora rollout runbook"]) {
  rec.systemPrompts.length = 0;
  const turn = await runtime.chat(q);
  const sys = rec.systemPrompts[0] ?? "";
  const i = sys.indexOf("Knowledge hits:");
  const block = i >= 0 ? sys.slice(i, i + 900) : "(no knowledge block)";
  console.log(`\n=== chat ${JSON.stringify(q)} ===`);
  console.log(block.startsWith("Knowledge hits:\nVesper withheld") ? "WITHHELD -> " + block : "DELIVERED -> " + block.slice(0, 700));
  const evs = turn.events.filter((e) => e.type === "security.untrusted_content");
  console.log("events:", evs.length ? evs.map((e) => `${e.severity}/${e.title}`).join(",") : "(none)");
}
await runtime.stop();
