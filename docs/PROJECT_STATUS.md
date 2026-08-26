# Project status

Phase: **software-only work continuing; the previous "software-only complete" claim was
wrong and has been retracted.**

## What changed, and why the previous status was retracted

The last session recorded "software-only target complete; remaining work is
hardware-dependent or unpublished APIs". An independent audit of the repository, plus
direct verification against the running product, found that this was not true. Among
what was still outstanding, and is now fixed:

- A real installation booted with **zero workspaces, zero approved applications, and
  zero knowledge sources**. "Get me ready for VRChat" answered "I could not launch the
  usual apps". Tests missed it because they never load a config file.
- The permission gate **failed open**: any level that was not `never` or `confirm` was
  allowed.
- A **symlink planted inside an approved directory escaped confinement** and its
  contents were returned. Reproduced before the fix.
- After the first tool use, **every later turn degraded to the offline stub**, because
  history kept tool calls that were never answered.
- Model tool arguments were **never validated**, though `required` and `enum` were
  advertised to the model.
- The benchmark harness — the file whose purpose is refusing fake numbers — reported
  **total latency as time-to-first-token** and **estimated tokens from character
  count**.
- On Windows, every path under `C:\Users` was refused as dangerous, making the confined
  filesystem tools and knowledge indexing **unusable on the only OS Vesper targets**.
  Found within minutes of adding a Windows CI job.
- Voice detected its backends and then never invoked them.
- There was **no background mode** and **no single-instance lock**.

The lesson is recorded in `CLAUDE.md` under "Invariants": each one is a defect that
shipped, with a regression test named after what broke.

## Validation (this session, on a Linux development host)

- Tests: **314 passing** (baseline at session start: 125)
- Security tests: **25 passing** (was 15)
- Typecheck (`tsc --noEmit`, test files included): passing
- Hygiene: passing
- Production check (`npm run build`): passing
- CI: **passing on ubuntu-latest and windows-latest** on every commit of this branch
- CodeQL (`security-extended`): **completed successfully on this branch's HEAD** —
  [run 32980070409](https://github.com/MMGSaint/Vesper-AI/actions/runs/32980070409).
  CodeQL is configured to run on `main` only, so it had never scanned this branch; it
  was dispatched explicitly to cover the ~10,000 changed lines.
- Secret scanning alerts: 0 · Dependabot alerts: 0

The shipped artifact was installed from scratch and run: extracted, `npm ci` from the
bundled lockfile, `--doctor` reporting OK, and a conversation that used tools and stored
memory — all from the packaged tree rather than the working copy. On Linux, not Windows.

Behaviour verified by running the product, not only by tests:

- Background mode stays alive with no TTY and exits cleanly on SIGTERM.
- A second host refuses to start; a lock left by a dead process is reclaimed.
- Crash post-mortem on next start: "The health file claims Vesper is running as pid
  28800, but that process is gone."
- The console holds a conversation, stores and retrieves memory, switches workspace,
  and prepares VRChat.
- The whole stack runs over a real socket against a server speaking Ollama's protocol:
  streaming, native tool calls, permission gate, and a well-formed later turn.
- `npm run package` produces a deterministic zip, byte-identical across builds and
  readable by an independent parser.

**None of this is hardware validation.** See "Blocked" below.

## Completed this session

Foundation and local AI
- Streaming, caller cancellation, and provider-reported token accounting in the model
  contract; benchmark reports only real measurements.
- Native Ollama provider; SSE streaming and tool-call reassembly for OpenAI-compatible
  backends; router fallback and lazy re-probe fixes.

Memory, knowledge, and context
- Scored memory retrieval; corrupt-entry resilience; BM25 with IDF and length
  normalisation; incremental reindex and globs; model-backed embeddings with lexical
  fallback and an honest downgrade report.
- Context budgeting, tool-result truncation, history integrity, serialized turns.

Product surface
- An interactive console that can approve confirmations, stream replies, cancel a turn
  with Ctrl-C, and manage memory and workspaces.
- Diagnostics that name the active embedding backend.
- Event log persistence and time correlation (`explain_change`), which is what lets
  Vesper say "OBS started recording 40s before" — timing only, never causation.

Windows and packaging
- Background mode, single-instance lock, honest health with pid and heartbeat, crash
  post-mortem, a real Windows adapter behind the abstraction, a chosen tray mechanism.
- Installer and runtime now agree on the config path, asserted by a test.
- `npm run package` builds a reproducible artifact with a manifest.
- CI runs on Windows as well as Linux.

Security
- Symlink-aware path confinement; default-deny permissions; tool argument validation;
  SSRF hardening and endpoint validation; audit trail for state-changing optimizer
  calls; audit-write failures can no longer kill the process.

## Blocked — requires the physical PC

Nothing below has been observed. See `docs/known-limitations.md`.

- Live AMD telemetry, clocks, power, temperatures
- Real Vulkan vs ROCm throughput on the 7900 XT
- Native tray icon, HKCU startup, toast delivery, `tasklist`, application launch/close
- Microphone capture and speaker playback
- Actual Ollama / llama.cpp model assignment and benchmarking
- Installer, uninstaller, and reset executed on Windows

## Blocked — requires an external API

- The real PC optimizer API is unpublished. The adapter, its transport hardening, and
  its audit trail are ready; the contract is a placeholder until the real one exists.

## Genuinely not implemented (software-only work that remains)

Stated plainly rather than classified as complete:

- **Companion transport.** `vesper.client` v1 is in-process only: no pairing, no
  listener, no LAN TLS. This is deliberately **not** built autonomously. Opening an
  inbound network listener on a personal machine is an outward-facing security decision
  that belongs to the owner, not to an agent working unattended. The scoped protocol and
  the in-process gateway are ready for it.

Completed since that list was first written: the **MCP client** (real stdio JSON-RPC,
namespaced and permission-gated) and **OBS WebSocket** (observed recording and streaming
state, feeding the event log so correlation can use it).

## Next on the real PC

1. Install Node 22, run `packaging/windows/install.ps1`, then `npm ci` in the install root
2. Launch the host; run `--doctor` and read the first-boot report
3. Install Ollama and/or llama.cpp with Vulkan; pull an embedding model
4. Re-run first-boot and the benchmark harness, and record the real numbers
5. Validate tray, startup registration, toasts, and application control
6. Point the optimizer adapter at the real API when it is published

When hardware becomes available, **validate every hardware-dependent item rather than
simulating success**.

## Integration

All of this work is **merged into `main`** as of `f1b08e7`.

PR #6 had taken only the first commit of this line of work; PR #7 integrated the
remaining 23. `agent/continuation` was a strict descendant of `main` — merge-base *was*
`main`, with no commits on `main` that the branch lacked — so it merged with no rebase,
squash, or cherry-pick, and every commit kept its original SHA. The merged tree is
byte-identical to the branch tip that CI had already validated.

Verified on the merge commit itself: 314 tests, 25 security tests, typecheck, hygiene,
and build all clean, with CI green on ubuntu-latest and windows-latest and CodeQL
(`security-extended`) green. The head branch was auto-deleted on merge; nothing is lost,
since every commit is reachable from `main`.
