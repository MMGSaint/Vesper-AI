# Project status

Phase: **Phase III — one assistant, multiple bodies.** The software-only beta
loop is frozen. This branch adds the identity, pairing, encrypted continuity,
and availability substrate so remaining work is integration, not a rewrite.

Treat gate numbers below as the last measured run on this branch. Re-run
`npm test`, `npm run security`, `npm run typecheck`, `npm run hygiene` from
the checkout rather than copying this file forward.

For the intelligence layer, see [intelligence.md](intelligence.md). For
continuity, [continuity.md](continuity.md). For hardware that is still
simulated, [known-limitations.md](known-limitations.md).

## Phase III (this branch)

Wired and tested on top of the green software-only beta:

- **VesperIdentity** is distinct from DeviceIdentity. It never holds a private
  key. Cloud is never required.
- **Pairing ledger** PENDING / TRUSTED / SUSPENDED / REVOKED is independent of
  DeviceRegistry trust. `restricted` remains the portable/USB class.
- **Outbox, inbox, and keyring persist across restart.** Rotation keeps previous
  versions so old envelopes still decrypt.
- **Privacy demotion** SHARED/GLOBAL → PRIVATE/DEVICE_ONLY emits a retraction
  tombstone. The local copy stays. The private value is not uploaded.
- **Cloudflare stub** reports `requires_credentials` and `live: false`.
- **Skill proposals** bind a hash. Apply is not enable. A changed hash is stale.
- **Browser/desktop seams** are disabled: no device opened, nothing executed.
- **Availability vocab** is mandatory on Command Center System/Nodes.
- Pairing tools are confirm-tier and host-only.

The kernel loop is unchanged: model → governor → permission → tool.

## Software-only beta (preserved)

Wired and tested:

- **Context assembly in the agent loop.** Retrieved memory is ranked by kind
  and provenance, secrets and session scope are dropped, instincts are labeled
  `not policy`, and the block is still screened as untrusted content. The
  `Relevant memory:` header is preserved so injection probes still find it.
- **Deterministic-first routing in the prompt.** When a procedure, skill, or
  tool matches, the system prompt states a preferred path and that it is not
  executed. Every tool still goes through the gate.
- **Durable jobs.** `job_create` enqueues a `durable_job` task. The executor
  plans, checkpoints, and may invoke read/safe tools under a `scheduled`
  origin. Confirm-tier waits. Never-tier is refused. Restart recovery
  re-queues open jobs and does not resume waiting-confirm unattended.
- **Command Center** is a playable beta surface for the same loop. It is not
  the Windows host.

Still true, and still not claimed as done:

- Production cloud credentials are absent. Continuity uses the local mock or the Cloudflare stub.
- NEXUS control API is unpublished. Mock stays mock. Stub stays stub.
- Target PC hardware (AMD telemetry, tray, WASAPI, USB) is unimplemented live.
- Startup registration stays off.


## Distributed and portable work

The distributed layer remains in place under the beta. Device identity, trust
states, capability manifests, memory scopes, remote authority limits, and the
untrusted content boundary were already built and tested before this branch.

Implemented and tested but **not a hosted service**:

- **Sync engine.** Conflict resolution and the engine are tested; calling them
  needs a transport. Capability discovery reports `sync` as `NOT_CONFIGURED`
  unless `sync.enabled` is on, which is accurate.
- **Session grants.** The signed portable grant model exists; the companion
  path uses device-bound client sessions instead.

Not built: any production transport, a mobile client, live NEXUS control.

## Gates (this branch)

Measured on `grok/phase-iii-bodies` after Phase III:

- tests: 1328 pass, 0 fail, 0 skip (was 1301)
- security: 424 pass, 29 files (was 417)
- typecheck: clean
- hygiene: clean · 460 files
- build: `tsc --noEmit` clean

## Historical retraction (kept)

The last session recorded "software-only target complete" too early, before
intelligence was the agent's default path and before jobs drove the scheduler.
That over-claim is why this file now describes wiring rather than class names.

Earlier defects that shipped and were fixed (permission fail-open, symlink
escape, dangling tool calls, unbounded retrieval, Windows path refusal, and
the rest) stay as named regression tests. See `CLAUDE.md` invariants.
