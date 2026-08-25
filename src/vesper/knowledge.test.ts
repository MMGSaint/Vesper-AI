import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeIndex } from "./knowledge/rag.ts";
import { createUnavailableEmbeddings, cosineSimilarity } from "./knowledge/embeddings.ts";
import { testRuntime } from "./test-helpers.ts";

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

  it("registers and removes sources inside approved roots only", async () => {
    const index = new KnowledgeIndex([], [], { approvedRoots: ["docs"] });
    const ok = index.registerSource({
      id: "notes",
      name: "notes",
      roots: ["docs"],
      enabled: true,
    });
    assert.equal(ok.ok, true);
    const removed = index.removeSource("notes");
    assert.equal(removed.ok, true);
    const embeddings = createUnavailableEmbeddings();
    assert.equal(embeddings.available(), false);
    assert.equal(await embeddings.embed(["hi"]), null);
    assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.9);
  });

  it("queues confirmation before registering a knowledge source", async () => {
    const runtime = await testRuntime();
    const pending = await runtime.tools.invoke({
      name: "knowledge_register",
      args: { id: "extra", name: "extra", root: "docs" },
      workspaceId: "general",
    });
    assert.equal(pending.decision.requiresConfirmation, true);
    const confirmed = await runtime.tools.invoke({
      name: "knowledge_register",
      args: { id: "extra", name: "extra", root: "/" },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(confirmed.result?.ok, false);
  });
});
