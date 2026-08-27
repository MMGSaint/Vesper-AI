// Does the doubled-slash bypass of isDangerousRoot give DEEP access to a whole home
// directory (the case PROFILE_CONTAINER exists to refuse)?
import { KnowledgeIndex } from "../../../../src/vesper/knowledge/rag.ts";

const idx = new KnowledgeIndex([], [], { approvedRoots: [] });
console.log('registerSource "/home/user"  ->', JSON.stringify(idx.registerSource({ id: "a", name: "a", roots: ["/home/user"], enabled: true })));
console.log('registerSource "//home/user" ->', JSON.stringify(idx.registerSource({ id: "b", name: "b", roots: ["//home/user"], enabled: true })));
const t = Date.now();
console.log("indexed docs:", await idx.reindex(), `(${Date.now() - t}ms)`);
const hits = await idx.search("SECRET OUTSIDE ROOT", 3);
console.log("search ->", JSON.stringify(hits.map((h) => ({ src: h.sourceId, path: h.path, snippet: h.snippet.slice(0, 40) })), null, 1));
