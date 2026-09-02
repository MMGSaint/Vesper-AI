# Personal intelligence layer

Vesper's memory, procedures, skills, and continuity already exist. This layer
does not replace them. It answers a different question: *what does this mean
for this user, right now, and how should it be done without asking a model to
reinvent a known path?*

## What it is

| Piece | Role |
| --- | --- |
| Kinds | core / preference / semantic / episodic / procedural / project / resource / vault / ephemeral — derived from existing categories + tags |
| Revision | stated > observed > inferred; supersede instead of silent overwrite; equal clocks dispute |
| Graph | JSON adjacency (`prefers`, `depends_on`, `superseded_by`, …). Not a graph database |
| Instincts | observation → candidate pattern. Never policy. Never a permission |
| Task packets | minimum context for a cloud/specialist worker. Secrets and never-tier stay home |
| Deterministic-first routing | active procedure → enabled skill → tool → model. Plans; does not execute |
| Durable jobs | restart-safe work records. Not tool calls |
| Context assembly | smallest useful set, budgeted, instincts labeled inferred |

## What it is not

- Not a rewrite of `MemoryStore`
- Not automatic self-modification
- Not a Cloudflare D1 backend (the continuity mock remains the sync foothold)
- Not permission to skip the gate
- Not always-on capture

## Tools

| Tool | Tier | Effect |
| --- | --- | --- |
| `context_now` | read | Assemble ranked personal context |
| `instinct_list` | read | List patterns |
| `instinct_observe` | safe | Record an observation |
| `graph_relate` | safe | Relate two nodes |
| `job_list` | read | List durable jobs (trusted devices only) |
| `job_create` | safe | Record a job; does not execute |
| `vesper_route` | read | Show the plan; `executed: false` |

## Config

```json
{ "intelligence": { "graph": true, "instincts": true, "jobs": true } }
```

There is no `autoPromote` flag. Instincts cannot become policy from configuration.
