# Ecosystem research — decisions for Vesper

Studied against the current repository, not as a shopping list.

| Source | Capability | Decision | Why |
| --- | --- | --- | --- |
| Letta / MemGPT | Core vs archival memory, OS-like context tiers | **Adapt** as kinds + assembly | Do not let the model freely rewrite core memory. Vesper ranks and budgets. |
| Mem0 | Selective write/retrieve | **Already present** (scored retrieval, not every turn dumped) | Keep; assembly tightens it further. |
| MIRIX | Multi-type memory + computer context | **Adapt** kinds; **reject** always-on capture | Context sources stay independently off. |
| Hermes-style skills | Progressive disclosure of skill summaries | **Already present** (skill registry lifecycle) | Full manifests load on demand; enabling is confirm-tier. |
| Claude Code instincts | Lightweight behavioral observations | **Adapt** | Instincts have evidence and confidence; never silent policy. |
| Browser Use / Workflow Use | Deterministic conversion of a procedure | **Adapt** | Active procedures outrank a model. Execution still hits the gate. |
| LangGraph | Durable jobs / checkpoints | **Adapt** (JobStore + existing CheckpointStore) | Do not import the framework. |
| Agent Zero | Dynamic computer-use agent | **Reject as default** | Too much OS authority. Specialists stay scoped. |
| MCP | Tool interoperability | **Already present** | Namespaced, confirm-tier by default. |
| A2A | Agent-to-agent packets | **Adapt** as TaskPacket | External workers get minimum context, never the memory store. |
| Grok Bot | Cloud jobs, teams, computer use | **Benchmark, do not clone** | Vesper wins on personal memory, device graph, trust, local-first. |
| Cortex / OpenJarvis | Encrypted sync, device identity | **Already present** (continuity foothold) | Cloud remains optional ciphertext. |
| Screenpipe | Always-on capture | **Rejected** | Off means no work. |
| Vector DB / SQLite rewrite | New store | **Rejected for now** | JSON + existing retrieval is enough. |

Strategic split:

- Grok Bot = general cloud intelligence + cloud execution
- Vesper = personalized intelligence + local environment + persistent memory + learned procedures + device graph + trust + provider neutrality
