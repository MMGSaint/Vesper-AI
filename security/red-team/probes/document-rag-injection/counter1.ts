// Counter-test: legitimate security documentation must stay retrievable and readable.
import { readFile, readdir } from "node:fs/promises";
import { decideUntrusted, screenForInjection } from "../../../../src/vesper/untrusted.ts";
import { KnowledgeIndex } from "../../../../src/vesper/knowledge/rag.ts";

const dir = "/home/user/vesper-probes/document-rag-injection/realdocs";
const names = await readdir(dir);
const seed = [] as { sourceId: string; path: string; title: string; text: string }[];
for (const n of names) {
  const text = await readFile(`${dir}/${n}`, "utf8");
  seed.push({ sourceId: "vesper-docs", path: n, title: n, text });
}
console.log("== whole-file screening of Vesper's OWN shipped docs ==");
for (const d of seed) {
  const v = screenForInjection(d.text);
  const dec = decideUntrusted(d.text, { source: "knowledge", origin: "vesper-docs", locator: d.path });
  if (dec.action !== "wrap") console.log(`${d.path.padEnd(26)} score=${String(v.score).padStart(3)} sev=${v.severity.padEnd(6)} explanatory=${v.explanatory} action=${dec.action}`);
}
console.log("(only non-'wrap' actions listed above)");

const index = new KnowledgeIndex([{ id: "vesper-docs", name: "docs", roots: [], enabled: true }], seed);
await index.reindex();
for (const q of ["prompt injection", "permission gate confirmation", "untrusted content boundary", "how does vesper defend against injection"]) {
  const hits = index.search(q, { limit: 4 });
  const joined = hits.map((h) => `- ${h.title}: ${h.snippet}`).join("\n");
  const dec = decideUntrusted(joined, { source: "knowledge", origin: `${hits.length} approved source hit(s)` }, { maxChars: 3000 });
  console.log(`\nQUERY ${JSON.stringify(q)} -> ${hits.length} hits: ${hits.map(h=>h.path).join(", ")}`);
  console.log(`  agent-level action=${dec.action} score=${dec.verdict.score} sev=${dec.verdict.severity} explanatory=${dec.verdict.explanatory}`);
  if (dec.action !== "wrap") console.log("  NOTICE:", dec.notice);
}
