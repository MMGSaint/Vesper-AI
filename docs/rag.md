# Local knowledge / RAG

IMPLEMENTED + TESTED.

- Approved source register/remove, workspace isolation (Mortis-approved notes stay in
  the Mortis workspace)
- Path confinement to `approvedRoots`, **resolving symlinks** — a link planted inside an
  approved directory used to be indexed and read through to its target outside
- Include/exclude globs are honoured, not validated and then ignored
- Chunking with overlap, provenance (`sourceId`, `path`, `offset`)
- Incremental reindex keyed on mtime and size, with deletion handling
- One unreadable or racing entry is skipped instead of abandoning the whole index

## Ranking

Real **BM25** with IDF over the whole indexed corpus and document-length normalisation.
IDF is measured over the corpus rather than the workspace-filtered subset, so a term
does not change weight depending on who is asking.

BM25 is unbounded and its absolute scale depends on corpus size, while cosine
similarity is already bounded. Mixing them against a fixed constant would weight the two
signals differently on every corpus, so the lexical score is normalised against the best
match **for that query** before the hybrid score is formed.

## Embeddings

`EmbeddingProvider` accepts a model-backed embedder. `createProviderEmbeddings` runs
embeddings through a local backend (Ollama `/api/embed`), batched; a short batch fails
the whole call rather than returning a misaligned vector list.

`createFallbackEmbeddings` prefers the real model and degrades to lexical hashing when
it is absent or failing — and **reports which mode is active** rather than hiding the
downgrade. Diagnostics names both the configured provider and the one the index was
actually built with.

`search()` is synchronous and can only use a lexical embedder; `searchAsync()` awaits a
model-backed query embedding. Both share one ranker so they cannot drift. The
synchronous path stays lexical even when the model backend is healthy, because scoring a
lexical query vector against model vectors would compare two different vector spaces.

Retrieval without an embedding backend cannot match a question that shares no words with
the stored text. That is a real limitation, not a bug.

Do not index the whole disk.
