import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeIndex } from "./knowledge/rag.ts";

describe("knowledge", () => {
  it("searches seeded documents and respects workspace sources", () => {
    const index = new KnowledgeIndex(
      [
        {
          id: "vesper-docs",
          name: "docs",
          roots: [],
          enabled: true,
        },
        {
          id: "mortis-approved",
          name: "mortis",
          roots: [],
          workspaceIds: ["mortis"],
          enabled: true,
        },
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
    const hits = index.search("specialists");
    assert.ok(hits.some((hit) => hit.title === "Architecture"));
    const mortis = index.search("Approved Mortis", { workspaceId: "general" });
    assert.equal(
      mortis.some((hit) => hit.sourceId === "mortis-approved"),
      false,
    );
  });
});
