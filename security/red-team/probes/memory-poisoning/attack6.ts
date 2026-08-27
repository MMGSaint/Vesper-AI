// Attack 6: memory FLOOD. The gateway records every remote write as source:"user" /
// kind:"stated", which is the store's PROTECTED eviction rank. Does a remote device
// with memory.write evict the person's own stated memories, and is that surfaced?
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";

const runtime = await testRuntime();
const ws = runtime.workspaces.current().id;
const keep = await runtime.memory.remember({
  category: "preference", key: "never touch my tax folder",
  value: "never touch my tax folder", workspaceId: ws, source: "user",
});
console.log("human memory stored:", keep.id, keep.key);

const gw = createClientGateway(runtime);
const peer = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
const s = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["status", "conversation", "memory.read", "memory.write"] as never });
if ("ok" in s) throw new Error("no session");

for (let i = 0; i < 520; i += 1) {
  const r = await gw.remember(s.token, { key: `flood-${i}`, value: `filler ${i}`, category: "fact" });
  if ("ok" in r) { console.log("stopped at", i, JSON.stringify(r)); break; }
}
const all = await runtime.memories();
console.log("total entries:", all.length);
console.log("human memory still present:", all.some((e) => e.id === keep.id));
console.log("seeded memories still present:", all.filter((e) => e.source === "seed").map((e) => e.key));
console.log("store health:", JSON.stringify(await runtime.memory.health()));
console.log("notices about dropping user-stated memory:",
  runtime.memory.notices().filter((n) => n.kind === "pruned-stated").length);
console.log("sample notice:", JSON.stringify(runtime.memory.notices().find((n) => n.kind.startsWith("pruned"))));
console.log("does the runtime surface these anywhere? events emitted:", runtime.events.recent?.(50)?.filter?.((e: any) => /memor/i.test(JSON.stringify(e))).length ?? "n/a");
await runtime.stop();
