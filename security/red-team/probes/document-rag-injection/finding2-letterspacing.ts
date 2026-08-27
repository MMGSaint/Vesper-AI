// FINDING 2 repro: the obfuscation layer folds zero-width chars, bidi controls and
// unicode confusables, but not interstitial spacing. The SAME directive scores 100 with
// zero-width joins and 0 when spelled letter-by-letter, so it is delivered into the
// system prompt with no screening signal and no user-facing disclosure.
import { readFile } from "node:fs/promises";
import { screenForInjection, decideUntrusted } from "../../../../src/vesper/untrusted.ts";
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { recordingProvider } from "./lib.ts";

const base = "/home/user/vesper-probes/document-rag-injection/finding2/";
for (const f of ["zerowidth.md", "docs/spaced.md"]) {
  const t = await readFile(base + f, "utf8");
  const v = screenForInjection(t);
  const d = decideUntrusted(t, { source: "knowledge", origin: "1 approved source hit(s)" }, { maxChars: 3000 });
  console.log(`${f.padEnd(13)} score=${String(v.score).padStart(3)} sev=${v.severity.padEnd(6)} action=${d.action.padEnd(6)} signals=[${v.signals.map((s) => s.id).join(",")}]`);
}

// End to end, with only the letter-spaced document present.
const rec = recordingProvider([]);
const runtime = await testRuntime({ providers: [rec.provider] });
await runtime.knowledge.reindex();
const turn = await runtime.chat("aurora rollout notes");
const sys = rec.systemPrompts[0] ?? "";
const i = sys.indexOf("Knowledge hits:");
console.log("\nDELIVERED TO MODEL:\n" + sys.slice(i, i + 1200));
console.log("\nsecurity.untrusted_content events this turn:",
  turn.events.filter((e) => e.type === "security.untrusted_content").length);
await runtime.stop();
