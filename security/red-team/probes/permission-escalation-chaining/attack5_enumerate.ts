import { testRuntime } from "../../../../src/vesper/test-helpers.ts";
import { decideRemoteToolRequest } from "../../../../src/vesper/tools/remote.ts";

const rt = await testRuntime();
const specs = rt.tools.list();
// A restricted device with an empty manifest (typical), trust=restricted.
const origin = { kind: "remote" as const, deviceId: "phone", trust: "restricted" as const, manifest: null, scopes: [] as any[] };
const reachable: string[] = [];
const blocked: string[] = [];
for (const s of specs) {
  const d = decideRemoteToolRequest({ toolName: s.name, origin });
  (d.allowed ? reachable : blocked).push(`${s.name}[${s.permission}]`);
}
console.log("REACHABLE by restricted remote device (no scopes, empty manifest):");
console.log("  " + reachable.join("\n  "));
console.log("\nBLOCKED:");
console.log("  " + blocked.join(", "));
await rt.stop();
