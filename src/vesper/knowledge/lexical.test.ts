import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bm25, buildLexicalIndex } from "./lexical.ts";

describe("bm25", () => {
  it("gives a term that appears everywhere almost no weight", () => {
    const index = buildLexicalIndex([
      "vesper vesper vesper hotspot",
      "vesper vesper vesper",
      "vesper vesper vesper",
      "vesper vesper vesper",
    ]);
    const common = bm25(["vesper"], index, 0);
    const rare = bm25(["hotspot"], index, 0);
    assert.ok(rare > common, `rare term ${rare} should beat common term ${common}`);
  });

  it("normalises for document length", () => {
    const short = "hotspot reading";
    const long = `hotspot reading ${"filler ".repeat(200)}`;
    const index = buildLexicalIndex([short, long, "unrelated gardening notes"]);
    assert.ok(bm25(["hotspot"], index, 0) > bm25(["hotspot"], index, 1));
  });

  it("scores nothing for a term the document does not contain", () => {
    const index = buildLexicalIndex(["alpha beta", "gamma delta"]);
    assert.equal(bm25(["omega"], index, 0), 0);
    assert.equal(bm25(["alpha"], index, 5), 0);
  });

  it("does not let a repeated query term count twice", () => {
    const index = buildLexicalIndex(["alpha beta gamma", "delta"]);
    assert.equal(bm25(["alpha", "alpha"], index, 0), bm25(["alpha"], index, 0));
  });
});
