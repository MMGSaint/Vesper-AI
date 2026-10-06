# Vesper third-party integration ledger

Vesper is intentionally a composition layer. Mature projects provide difficult plumbing; Vesper keeps the personality, memory model, permission boundary and local orchestration.

## Model backends

- **Ollama**: local model host. MIT licensed. Vesper talks to its documented local API; Ollama remains an independently installed process.
- **llama.cpp**: local inference/runtime option. MIT licensed for the main project, with third-party files retaining their own notices.

## Tool protocol

- **Model Context Protocol (MCP)** is the preferred tool protocol for future external/local tool packs. Vesper should adapt MCP tools through its existing permission gate rather than allowing an MCP server to become an authority boundary.

## Voice

- **whisper.cpp / faster-whisper family** may provide local speech-to-text.
- **Piper** may provide local speech synthesis.
- Vesper treats both as optional subprocesses and never assumes an audio device is available just because a binary exists.

## Memory

Vesper currently keeps its core storage API deliberately dependency-light. SQLite/FTS and sqlite-vec are candidates for the durable retrieval layer once the current storage compatibility tests can prove a migration is lossless. A vector index is an accelerator, not a source of truth: if it is unavailable, Vesper must still be able to retrieve exact memories or degrade honestly.

## Rule

> Borrow mature plumbing; keep Vesper's authority and identity.

External processes may observe, infer, transcribe or generate. They do not receive Vesper permissions merely because they are installed.
