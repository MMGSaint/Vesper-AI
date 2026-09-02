import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { GraphError, KnowledgeGraph } from "./graph.ts";

describe("knowledge graph", () => {
  it("records prefers/depends_on without executing anything", async () => {
    const graph = new KnowledgeGraph(new MemoryStorage());
    const user = await graph.upsertNode({ type: "person", label: "user" });
    const vim = await graph.upsertNode({ type: "preference", label: "vim" });
    const mortis = await graph.upsertNode({ type: "project", label: "Mortis" });
    await graph.relate({ type: "prefers", from: user.id, to: vim.id });
    await graph.relate({ type: "belongs_to", from: vim.id, to: mortis.id });
    const around = await graph.neighbors(user.id);
    assert.equal(around.length, 1);
    assert.equal(around[0]?.node.label, "vim");
  });

  it("refuses secret-shaped labels", async () => {
    const graph = new KnowledgeGraph(new MemoryStorage());
    await assert.rejects(() => graph.upsertNode({ type: "resource", label: "api_key sk-live" }), GraphError);
  });

  it("flags conflicting prefers edges", async () => {
    const graph = new KnowledgeGraph(new MemoryStorage());
    const user = await graph.upsertNode({ type: "person", label: "user" });
    const vim = await graph.upsertNode({ type: "preference", label: "vim" });
    const emacs = await graph.upsertNode({ type: "preference", label: "emacs" });
    await graph.relate({ type: "prefers", from: user.id, to: vim.id });
    await graph.relate({ type: "prefers", from: user.id, to: emacs.id });
    const conflicts = await graph.conflictingPreferences();
    assert.equal(conflicts.length, 1);
  });
});
