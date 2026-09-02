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
| Durable jobs | restart-safe work records driven by TaskScheduler. Not a bypass of the gate |
| Context assembly | smallest useful set, budgeted, instincts labeled inferred — this is the agent's default memory path |

## What it is not

- Not a rewrite of `MemoryStore`
- Not automatic self-modification
- Not a Cloudflare D1 backend (the continuity mock remains the sync foothold)
- Not permission to skip the gate
- Not always-on capture

## Wired into the loop

A turn now does:

1. Retrieve memory (still screened; remote sessions without `memory.read` still get nothing)
2. `assembleContext` ranks kinds/provenance, drops secrets and session scope, labels instincts **not policy**
3. `planExecution` may add a preferred path. `executed` is always false. The model is not told to skip the gate
4. Tools still go through `ToolRegistry.invoke`

`Relevant memory:` remains the header so existing injection probes still find the block. The bytes inside it are assembled, then screened.

## Jobs

`job_create` records a `JobStore` entry **and** enqueues a `durable_job` task.

```
job_create → TaskQueue → TaskScheduler.tick({ force, wait })
          → job executor → plan / checkpoint → tools.invoke (scheduled origin)
          → done | waiting_confirm | failed
```

- Named **read/safe** tools run unattended through the gate
- **confirm-tier** pauses the job; a scheduled origin cannot approve
- **never-tier** is refused at create time and again in the executor
- A title-only job checkpoints a plan and completes without inventing a grant
- Restart recovery re-queues queued/running/checkpointed jobs. Waiting-confirm stays paused
- `job_cancel` is safe-tier and trusted-only, same as `job_create`

A job being queued is still not authorization.

## Tools

| Tool | Tier | Effect |
| --- | --- | --- |
| `context_now` | read | Assemble ranked personal context |
| `instinct_list` | read | List patterns |
| `instinct_observe` | safe | Record an observation |
| `graph_relate` | safe | Relate two nodes |
| `job_list` | read | List durable jobs (trusted devices only) |
| `job_create` | safe | Record a job and drive it on the scheduler |
| `job_cancel` | safe | Cancel a job (does not reverse work already gated) |
| `vesper_route` | read | Show the plan; `executed: false` |

## Config

```json
{ "intelligence": { "graph": true, "instincts": true, "jobs": true } }
```

There is no `autoPromote` flag. Instincts cannot become policy from configuration.
`agent.driveTasksOnIdle` stays false by default. Creating a job drives **that**
scheduler pass with `force`, and does not turn idle task-driving on for everything else.
