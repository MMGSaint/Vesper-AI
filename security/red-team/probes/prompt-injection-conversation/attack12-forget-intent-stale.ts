/** A12: same defect at agent.ts:661 (executeIntent "forget") — filter() surfaces every
 *  queued memory_forget, so the owner's "forget junk" prompt carries an older one too. */
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
const runtime = await testRuntime({ script: [] });
await runtime.memory.remember({ category: "project", key: "mortis-boundary-note", value: "keep this", source: "user", provenance: { origin: "owner", kind: "stated" } });
await runtime.memory.remember({ category: "fact", key: "junk", value: "delete me", source: "user", provenance: { origin: "owner", kind: "stated" } });

const t1 = await runtime.chat("forget mortis-boundary-note");   // left unresolved
console.log("T1 surfaced:", t1.pendingConfirmations.map((p) => `${p.id.slice(0, 14)} ${p.toolName} ${JSON.stringify(p.args)}`));
const t2 = await runtime.chat("forget junk");
console.log("T2 reply   :", t2.reply);
console.log("T2 surfaced:", t2.pendingConfirmations.map((p) => `${p.id.slice(0, 14)} ${p.toolName} ${JSON.stringify(p.args)}`));
console.log("^ the owner asked to forget 'junk' and is prompted for BOTH, first one first.");
await runtime.stop();
