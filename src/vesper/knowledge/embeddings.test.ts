import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity,
  createFallbackEmbeddings,
  createHashEmbeddings,
  createProviderEmbeddings,
  createUnavailableEmbeddings,
} from "./embeddings.ts";
import { KnowledgeIndex } from "./rag.ts";
import type { KnowledgeSource } from "../types.ts";

/** A fake local embedding backend: one dimension per keyword, so scores are readable. */
function fakeBackend(options: { available?: boolean; fail?: boolean } = {}) {
  const KEYS = ["optimizer", "vrchat", "memory", "streaming"];
  const calls: string[][] = [];
  return {
    calls,
    isAvailable: () => options.available !== false,
    async embed(texts: string[]): Promise<number[][] | null> {
      calls.push(texts);
      if (options.fail) return null;
      return texts.map((text) => {
        const lower = text.toLowerCase();
        const vec: number[] = KEYS.map((key) => (lower.includes(key) ? 1 : 0));
        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vec.map((v) => v / norm);
      });
    },
  };
}

test("embedding providers", async (t) => {
  await t.test("provider embeddings call the backend and return vectors", async () => {
    const backend = fakeBackend();
    const provider = createProviderEmbeddings({
      id: "ollama-embed",
      model: "nomic-embed-text",
      isAvailable: backend.isAvailable,
      embed: (texts) => backend.embed(texts),
    });
    const vectors = await provider.embed(["the optimizer report", "vrchat session"]);
    assert.equal(vectors?.length, 2);
    assert.ok(cosineSimilarity(vectors![0], vectors![1]) < 0.5);
    assert.equal(await provider.embed([]).then((v) => v?.length), 0);
  });

  await t.test("provider embeddings batch large inputs", async () => {
    const backend = fakeBackend();
    const provider = createProviderEmbeddings({
      id: "ollama-embed",
      model: "m",
      isAvailable: backend.isAvailable,
      embed: (texts) => backend.embed(texts),
      batchSize: 2,
    });
    const vectors = await provider.embed(["a", "b", "c", "d", "e"]);
    assert.equal(vectors?.length, 5);
    assert.deepEqual(
      backend.calls.map((batch) => batch.length),
      [2, 2, 1],
    );
  });

  await t.test("an unreachable backend yields null rather than a partial index", async () => {
    const backend = fakeBackend({ available: false });
    const provider = createProviderEmbeddings({
      id: "ollama-embed",
      model: "m",
      isAvailable: backend.isAvailable,
      embed: (texts) => backend.embed(texts),
    });
    assert.equal(await provider.embed(["x"]), null);
    assert.equal(provider.available(), false);
    assert.match(provider.detail!(), /not reachable/);
  });

  await t.test("a short batch fails the whole call instead of misaligning vectors", async () => {
    const provider = createProviderEmbeddings({
      id: "ollama-embed",
      model: "m",
      isAvailable: () => true,
      // Returns fewer vectors than inputs: a silently shorter list would misalign
      // every document score after the gap.
      embed: async () => [[1, 0]],
    });
    assert.equal(await provider.embed(["a", "b"]), null);
    assert.match(provider.detail!(), /1 vectors for 2 inputs/);
  });

  await t.test("fallback prefers the real model and reports which one is active", async () => {
    const backend = fakeBackend();
    const primary = createProviderEmbeddings({
      id: "ollama-embed",
      model: "nomic-embed-text",
      isAvailable: backend.isAvailable,
      embed: (texts) => backend.embed(texts),
    });
    const provider = createFallbackEmbeddings(primary);
    const vectors = await provider.embed(["optimizer"]);
    assert.equal(vectors?.length, 1);
    assert.equal(provider.id, "ollama-embed");
    assert.match(provider.detail!(), /nomic-embed-text/);
  });

  await t.test("fallback degrades to lexical hashing and says why", async () => {
    const provider = createFallbackEmbeddings(
      createUnavailableEmbeddings(),
      createHashEmbeddings(16),
    );
    const vectors = await provider.embed(["optimizer report"]);
    assert.equal(vectors?.length, 1);
    assert.equal(vectors![0].length, 16, "lexical vectors are used");
    assert.match(provider.id, /lexical-hash \(fallback from none\)/);
    assert.match(provider.detail!(), /Using lexical-hash because none is unavailable/);
    // Retrieval still works; only its quality changed.
    assert.equal(provider.available(), true);
  });

  await t.test("fallback also engages when the backend errors mid-run", async () => {
    const backend = fakeBackend({ fail: true });
    const provider = createFallbackEmbeddings(
      createProviderEmbeddings({
        id: "ollama-embed",
        model: "m",
        isAvailable: backend.isAvailable,
        embed: (texts) => backend.embed(texts),
      }),
      createHashEmbeddings(16),
    );
    const vectors = await provider.embed(["optimizer"]);
    assert.equal(vectors![0].length, 16);
    assert.match(provider.detail!(), /fallback|because/i);
  });

  await t.test("synchronous embedding never mixes vector spaces", async () => {
    const backend = fakeBackend();
    const provider = createFallbackEmbeddings(
      createProviderEmbeddings({
        id: "ollama-embed",
        model: "m",
        isAvailable: backend.isAvailable,
        embed: (texts) => backend.embed(texts),
      }),
      createHashEmbeddings(16),
    );
    // The sync path is lexical even while the model backend is healthy, because a
    // 16-dim lexical query vector must never be scored against model vectors.
    assert.equal(provider.embedSync!("optimizer").length, 16);
  });
});

test("knowledge retrieval with a model-backed embedder", async (t) => {
  const seed = [
    {
      sourceId: "docs",
      path: "a.md",
      title: "Optimizer adapter",
      text: "The optimizer specialist reports telemetry and performance state.",
    },
    {
      sourceId: "docs",
      path: "b.md",
      title: "VRChat workflow",
      text: "Getting ready for vrchat launches the approved applications.",
    },
  ];
  const sources: KnowledgeSource[] = [
    { id: "docs", name: "Docs", roots: [], enabled: true },
  ];

  await t.test("searchAsync ranks using model vectors when available", async () => {
    const backend = fakeBackend();
    const index = new KnowledgeIndex(sources, seed, {
      embeddings: createProviderEmbeddings({
        id: "ollama-embed",
        model: "m",
        isAvailable: backend.isAvailable,
        embed: (texts) => backend.embed(texts),
      }),
    });
    await index.reindex();

    const hits = await index.searchAsync("vrchat", { limit: 2 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].title, "VRChat workflow");

    const status = index.embeddingStatus();
    assert.equal(status.providerId, "ollama-embed");
    assert.equal(status.indexedWith, "ollama-embed");
  });

  await t.test("retrieval still works with no embedding backend at all", async () => {
    const index = new KnowledgeIndex(sources, seed, {
      embeddings: createUnavailableEmbeddings(),
    });
    await index.reindex();

    const hits = await index.searchAsync("optimizer", { limit: 2 });
    assert.ok(hits.length >= 1, "lexical scoring still returns results");
    assert.equal(hits[0].title, "Optimizer adapter");
    assert.equal(index.embeddingStatus().indexedWith, null);
  });

  await t.test("a lexical embedder answers synchronously without extra calls", async () => {
    const index = new KnowledgeIndex(sources, seed, { embeddings: createHashEmbeddings(32) });
    await index.reindex();
    const viaAsync = await index.searchAsync("optimizer", { limit: 2 });
    const viaSync = index.search("optimizer", { limit: 2 });
    assert.deepEqual(
      viaAsync.map((h) => h.title),
      viaSync.map((h) => h.title),
    );
  });
});
