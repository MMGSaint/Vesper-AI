// Two ways to defeat `isDangerousRoot`, the deterministic refusal that is supposed to
// hold even after a human confirms:
//   (a) a doubled leading slash  ("//etc" -> path.resolve -> "/etc")
//   (b) a symlink inside an approved root whose target is a system directory
import { KnowledgeIndex } from "../../../../src/vesper/knowledge/rag.ts";
import { isDangerousRoot } from "../../../../src/vesper/security.ts";
import { resolve } from "node:path";

const B = "/home/user/vesper-probes/filesystem-escape/sandbox";
const APPROVED = `${B}/approved`;

console.log("=== (a) doubled leading slash ===");
for (const r of ["/etc", "//etc", "/home/user", "//home/user", "/root", "//root"]) {
  console.log(`isDangerousRoot(${JSON.stringify(r)}) =`, isDangerousRoot(r), "| resolve ->", resolve(r));
}

// approvedRoots empty == the zod schema default == "the user approved nothing"
const openIdx = new KnowledgeIndex([], [], { approvedRoots: [] });
console.log('registerSource root "/etc"  ->', JSON.stringify(openIdx.registerSource({ id: "a", name: "a", roots: ["/etc"], enabled: true })));
console.log('registerSource root "//etc" ->', JSON.stringify(openIdx.registerSource({ id: "b", name: "b", roots: ["//etc"], enabled: true })));
console.log("indexed docs:", await openIdx.reindex());
console.log("search 'rgb' ->", JSON.stringify((await openIdx.search("rgb color name", 2)).map((h) => ({ path: h.path, snippet: h.snippet.slice(0, 60) }))));

console.log("\n=== (b) symlink root inside an approved root, target = /etc ===");
const boundIdx = new KnowledgeIndex([], [], { approvedRoots: [APPROVED] });
console.log(
  'registerSource root "<approved>/etclink" ->',
  JSON.stringify(boundIdx.registerSource({ id: "c", name: "c", roots: [`${APPROVED}/etclink`], enabled: true })),
);
console.log("indexed docs:", await boundIdx.reindex());
console.log("search 'rgb' ->", JSON.stringify((await boundIdx.search("rgb color name", 2)).map((h) => ({ path: h.path, snippet: h.snippet.slice(0, 60) }))));
