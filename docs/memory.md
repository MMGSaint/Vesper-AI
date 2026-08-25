# Memory

Persistent local memory with:

- remember / retrieve / search / update / forget / summarize
- session vs persistent (`category: "session"` is in-memory only)
- FileStorage atomic writes + corrupt-JSON recovery
- serialized concurrent writes
- seed memories on first empty store
- explicit provenance (`stated` / `observed` / `inferred`)
- export/import of persistent memories (`exportPersistent` / `importPersistent`)
- host CLI `--export-memory` writes `data/memory-export.json`

Session memories are never exported. Secrets are not written to the audit log. Memory values themselves stay local.

Classification: **IMPLEMENTED + TESTED**.
