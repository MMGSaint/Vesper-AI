# Local knowledge / RAG

IMPLEMENTED + TESTED.

- Approved source register/remove
- Path confinement to `approvedRoots`
- Chunking with overlap
- BM25-style lexical search
- Local lexical-hash embeddings (not a neural model; honest local vectors)
- Hybrid score when embeddings are available
- Provenance (`sourceId`, `path`, `offset`)
- Workspace isolation (Mortis-approved notes stay in the Mortis workspace)
- Reindex skips unreadable files instead of crashing

Not implemented: live GPU embedding models. A neural embedding provider can be injected through `EmbeddingProvider` later without changing the index API.

Do not index the whole disk.
