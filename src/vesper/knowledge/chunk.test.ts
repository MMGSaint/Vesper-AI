import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "./chunk.ts";
import { createHashEmbeddings, cosineSimilarity, type EmbeddingProvider } from "./embeddings.ts";
import { KnowledgeIndex } from "./rag.ts";

/** Pins the dense half of hybrid scoring so ranking is not left to hash collisions. */
function fixedEmbeddings(queryVector: number[]): EmbeddingProvider {
  return {
    id: "test-fixed",
    available: () => true,
    embedSync: () => queryVector,
    async embed(texts: string[]) {
      return texts.map((text) => (text.includes("MARKER") ? [1, 0] : [0, 1]));
    },
  };
}

describe("knowledge chunking and local embeddings", () => {
  it("chunks long text with overlap", () => {
    const text = "alpha ".repeat(200) + "\n\n" + "omega ".repeat(200);
    const chunks = chunkText(text, 200, 40);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0]?.offset, 0);
  });

  it("hash embeddings are deterministic and similar for related text", async () => {
    const embeddings = createHashEmbeddings(32);
    const [a, b, c] = (await embeddings.embed([
      "VRChat is running on this PC",
      "VRChat session is active",
      "completely unrelated gardening notes",
    ]))!;
    assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c));
  });

  it("hybrid search still respects workspace isolation after reindex", async () => {
    const index = new KnowledgeIndex(
      [
        { id: "vesper-docs", name: "docs", roots: [], enabled: true },
        { id: "mortis-approved", name: "mortis", roots: [], workspaceIds: ["mortis"], enabled: true },
      ],
      [
        {
          sourceId: "vesper-docs",
          path: "architecture.md",
          title: "Architecture",
          text: "Vesper coordinates specialists and never absorbs Mortis canon.",
        },
        {
          sourceId: "mortis-approved",
          path: "boundary.md",
          title: "Mortis boundary",
          text: "Approved Mortis notes only. Separate codebase.",
        },
      ],
    );
    await index.reindex();
    const hits = index.search("specialists");
    assert.ok(hits.some((hit) => hit.title === "Architecture"));
    assert.ok(hits[0]?.provenance?.path);
    const mortis = index.search("Approved Mortis", { workspaceId: "general" });
    assert.equal(
      mortis.some((hit) => hit.sourceId === "mortis-approved"),
      false,
    );
  });

  it("keeps a dense-only neighbour but ranks the lexical match first", async () => {
    const index = new KnowledgeIndex(
      [{ id: "docs", name: "docs", roots: [], enabled: true }],
      [
        { sourceId: "docs", path: "a.md", title: "A", text: "hotspot telemetry notes" },
        { sourceId: "docs", path: "b.md", title: "B", text: "unrelated MARKER prose" },
      ],
      { embeddings: fixedEmbeddings([1, 0]) },
    );
    await index.reindex();
    const hits = index.search("hotspot");
    assert.equal(hits.length, 2, "the dense-only neighbour is still recalled");
    assert.equal(hits[0]?.title, "A");
    assert.ok(hits[0]!.score > hits[1]!.score);
    // Hybrid scores stay bounded, so a long document cannot swamp the dense signal.
    assert.ok(hits.every((hit) => hit.score <= 1.15));
  });

  it("drops a document that neither matches lexically nor agrees densely", async () => {
    const index = new KnowledgeIndex(
      [{ id: "docs", name: "docs", roots: [], enabled: true }],
      [
        { sourceId: "docs", path: "a.md", title: "A", text: "hotspot telemetry MARKER" },
        { sourceId: "docs", path: "b.md", title: "B", text: "unrelated prose" },
      ],
      { embeddings: fixedEmbeddings([1, 0]) },
    );
    await index.reindex();
    assert.deepEqual(
      index.search("hotspot").map((hit) => hit.title),
      ["A"],
    );
  });
});
