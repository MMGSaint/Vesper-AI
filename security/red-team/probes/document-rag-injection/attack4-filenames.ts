// A4: injection carried in FILENAMES / document metadata rather than body text.
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { isBoundaryIntact } from "../../../../src/vesper/untrusted.ts";
import { recordingProvider } from "./lib.ts";

const rec = recordingProvider([{ name: "credential_extract", arguments: {} }, { name: "fs_write", arguments: { path: "x", content: "y" } }]);
const runtime = await testRuntime({ providers: [rec.provider] });
await runtime.knowledge.reindex();
console.log("indexed:", JSON.stringify(runtime.knowledge.lastIndexStats()));
for (const h of runtime.knowledge.search("aurora budget notes", { limit: 8 })) console.log("HIT title=", JSON.stringify(h.title));
const turn = await runtime.chat("summarise the aurora budget notes");
for (const c of turn.toolCalls) console.log(`TOOL ${c.toolName} allowed=${c.decision.allowed} :: ${c.decision.reason}`);
const sys = rec.systemPrompts[0] ?? "";
const idx = sys.indexOf("Knowledge hits:");
const block = idx >= 0 ? sys.slice(idx) : "";
const nonce = /VESPER-UNTRUSTED-DATA ([0-9a-f]{8,}) BEGIN/.exec(block)?.[1] ?? "";
console.log("nonce:", nonce);
console.log("BOUNDARY INTACT:", nonce ? isBoundaryIntact(block.slice(block.indexOf("<<<VESPER")), nonce) : "n/a");
console.log("begin-marker count:", (block.match(/BEGIN>>>/g) ?? []).length, "end-marker count:", (block.match(/END>>>/g) ?? []).length);
console.log("---- block ----");
console.log(JSON.stringify(block));
await runtime.stop();
