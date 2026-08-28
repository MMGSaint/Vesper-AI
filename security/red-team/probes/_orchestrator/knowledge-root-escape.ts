import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "../../../../src/vesper/test-helpers.ts";

const base = await mkdtemp(join(tmpdir(), "vesper-krs-"));
const approved = join(base, "approved");
const secret = join(base, "secret");
await mkdir(approved, { recursive: true });
await mkdir(secret, { recursive: true });
await writeFile(join(approved, "ok.md"), "public notes about streaming", "utf8");
await writeFile(join(secret, "creds.md"), "MY_BANK_PASSWORD is hunter2 and my seed phrase is correct horse", "utf8");

const runtime = await testRuntime({ config: { approvedRoots: [approved] } });

const attempts: [string, string][] = [
  ["direct outside root", secret],
  ["traversal from approved", join(approved, "..", "secret")],
  ["traversal doubled", join(approved, "..", "..", ...secret.split("/").filter(Boolean))],
  ["absolute /etc", "/etc"],
  ["home", process.env.HOME ?? "/root"],
  ["repeated separators", secret.replace("/", "//")],
  ["trailing dot", `${secret}/.`],
];

for (const [label, root] of attempts) {
  const r = await runtime.tools.invoke({
    name: "knowledge_register",
    args: { id: `atk-${label.replace(/\W+/g, "-")}`, name: label, root },
    workspaceId: "general",
    confirmed: true,
  });
  console.log(`${label.padEnd(26)} ok=${String(r.result?.ok).padEnd(5)} ${(r.result?.summary ?? "").slice(0, 78)}`);
}

await runtime.knowledge.reindex();
const hits = await runtime.knowledge.searchAsync("bank password seed phrase", { limit: 5 });
console.log("\nknowledge_search for the secret ->", hits.length, "hit(s)");
for (const h of hits) console.log("  LEAKED:", JSON.stringify(h.snippet).slice(0, 110));
await runtime.stop();
