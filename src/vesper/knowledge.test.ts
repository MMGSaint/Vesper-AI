import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("ranks a relevant document above a filler-heavy one", () => {
    const filler =
      "the the the the is is is the number the the reading the the to the the watch the ".repeat(8);
    const index = new KnowledgeIndex(
      [{ id: "docs", name: "docs", roots: [], enabled: true }],
      [
        {
          sourceId: "docs",
          path: "thermals.md",
          title: "GPU thermals",
          text: "The RX 7900 XT hotspot reading is the number to watch.",
        },
        { sourceId: "docs", path: "filler.md", title: "Filler", text: filler },
      ],
    );
    const hits = index.search("the hotspot number is the reading to watch");
    assert.equal(hits[0]?.title, "GPU thermals");
  });

  it("removes a source without duplicating the seeded documents that remain", async () => {
    const index = new KnowledgeIndex(
      [
        { id: "keep", name: "keep", roots: [], enabled: true },
        { id: "drop", name: "drop", roots: [], enabled: true },
      ],
      [
        { sourceId: "keep", path: "keep.md", title: "Keep", text: "alpha document" },
        { sourceId: "drop", path: "drop.md", title: "Drop", text: "beta document" },
      ],
    );
    await index.reindex();
    assert.equal(index.search("alpha").length, 1);
    assert.equal(index.removeSource("drop").ok, true);
    assert.equal(index.search("alpha").length, 1);
    assert.equal(index.search("beta").length, 0);
    assert.equal(await index.reindex(), 1);
  });

  it("honours configured include and exclude globs during the walk", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesper-globs-"));
    await mkdir(join(root, "drafts"), { recursive: true });
    await writeFile(join(root, "published.md"), "published note about alpha", "utf8");
    await writeFile(join(root, "drafts", "wip.md"), "draft note about alpha", "utf8");
    await writeFile(join(root, "scratch.txt"), "scratch note about alpha", "utf8");

    const index = new KnowledgeIndex(
      [
        {
          id: "notes",
          name: "notes",
          roots: [root],
          include: ["**/*.md"],
          exclude: ["drafts/**"],
          enabled: true,
        },
      ],
      [],
      { approvedRoots: [root] },
    );
    assert.equal(await index.reindex(), 1);
    assert.deepEqual(
      index.search("alpha").map((hit) => hit.path),
      ["published.md"],
    );
    await rm(root, { recursive: true, force: true });
  });

  it("reuses unchanged files on reindex and forgets deleted ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesper-incremental-"));
    await writeFile(join(root, "one.md"), "first note about alpha", "utf8");
    await writeFile(join(root, "two.md"), "second note about beta", "utf8");
    const index = new KnowledgeIndex(
      [{ id: "notes", name: "notes", roots: [root], enabled: true }],
      [],
      { approvedRoots: [root] },
    );

    await index.reindex();
    assert.equal(index.lastIndexStats()?.filesRead, 2);

    await index.reindex();
    const cached = index.lastIndexStats();
    assert.equal(cached?.filesRead, 0, "an unchanged tree is not re-read");
    assert.equal(cached?.filesReused, 2);
    assert.equal(cached?.embedded, false, "unchanged documents are not re-embedded");

    // mtime alone can collide within a millisecond, so the size change is what makes
    // this deterministic; both are compared.
    await writeFile(join(root, "one.md"), "first note about alpha and gamma too", "utf8");
    await index.reindex();
    assert.equal(index.lastIndexStats()?.filesRead, 1);
    assert.equal(index.lastIndexStats()?.filesReused, 1);
    assert.equal(index.search("gamma").length, 1);

    await rm(join(root, "two.md"));
    await index.reindex();
    assert.equal(index.lastIndexStats()?.filesDropped, 1);
    assert.equal(index.search("beta").length, 0);
    await rm(root, { recursive: true, force: true });
  });
});
