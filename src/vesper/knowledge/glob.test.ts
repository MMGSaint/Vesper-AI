import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { excludesDirectory, includesFile, matchesGlob } from "./glob.ts";

describe("knowledge glob matching", () => {
  it("matches segment wildcards without crossing separators", () => {
    assert.equal(matchesGlob("notes.md", "*.md"), true);
    assert.equal(matchesGlob("deep/notes.md", "*.md"), true, "a bare name filter applies at any depth");
    assert.equal(matchesGlob("deep/notes.md", "/deep/*.md"), true);
    assert.equal(matchesGlob("deep/deeper/notes.md", "deep/*.md"), false);
    assert.equal(matchesGlob("deep/deeper/notes.md", "deep/**/*.md"), true);
    assert.equal(matchesGlob("notes.md", "**/*.md"), true);
    assert.equal(matchesGlob("note1.md", "note?.md"), true);
    assert.equal(matchesGlob("note12.md", "note?.md"), false);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    assert.equal(matchesGlob("release(1).md", "release(1).md"), true);
    assert.equal(matchesGlob("releaseX1Y.md", "release(1).md"), false);
  });

  it("uses backslash paths from Windows walks", () => {
    assert.equal(matchesGlob("docs\\api\\index.md", "docs/**/*.md"), true);
  });

  it("applies include as an allow-list and exclude as a veto", () => {
    const filters = { include: ["**/*.md"], exclude: ["drafts/**", "*.secret.md"] };
    assert.equal(includesFile("guide.md", filters), true);
    assert.equal(includesFile("guide.txt", filters), false);
    assert.equal(includesFile("drafts/guide.md", filters), false);
    assert.equal(includesFile("guide.secret.md", filters), false);
    assert.equal(includesFile("anything.txt", undefined), true);
  });

  it("prunes a directory only when a pattern covers everything under it", () => {
    assert.equal(excludesDirectory("drafts", ["drafts/**"]), true);
    assert.equal(excludesDirectory("drafts", ["drafts"]), true);
    assert.equal(excludesDirectory("keep", ["drafts/**"]), false);
    assert.equal(excludesDirectory("keep", undefined), false);
    assert.equal(excludesDirectory("keep", ["*.secret.md"]), false);
  });
});
