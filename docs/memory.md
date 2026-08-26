# Memory

Persistent local memory with:

- remember / retrieve / search / update / forget / summarize
- **scored retrieval over natural sentences.** Search used to match the whole query
  string as a substring, so "what did I say about streaming on Fridays" matched nothing
  and the agent's auto-injected memory context was empty in practice. It now tokenises
  and scores by term overlap, weighting key, value, category, recency, and workspace.
- **a corrupt entry is skipped, not fatal.** One malformed persisted entry used to break
  every conversational turn.
- session vs persistent (`category: "session"` is in-memory only)
- FileStorage atomic writes + corrupt-JSON recovery
- serialized concurrent writes
- seed memories on first empty store
- explicit provenance (`stated` / `observed` / `inferred`)
- export/import of persistent memories (`exportPersistent` / `importPersistent`)
- host CLI `--export-memory` writes `data/memory-export.json`

Session memories are never exported. Secrets are not written to the audit log. Memory values themselves stay local.

`remember preference: …` names a category in conversation exactly as the console's
`/remember` does; the two interfaces used to disagree.

Classification: **IMPLEMENTED + TESTED**.
