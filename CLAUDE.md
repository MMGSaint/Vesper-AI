# Vesper — agent instructions

Vesper is a **local-first personal AI assistant** for a Windows PC. Prefer `AGENTS.md` as the operating contract. This file is retained as project memory.

## Identity

- **Vesper** = personal assistant (this repository)
- **Mortis** = a separate RP/world/project ecosystem. Do not rename, migrate, copy, or absorb it.
- **PC Optimizer** = a separate specialist system. Do not rebuild, replace, or absorb it.

Vesper coordinates. Specialists stay specialists.

## Repository boundary

Public source of truth: https://github.com/MMGSaint/Vesper-AI

Keep this tree independently maintainable. Production runtime is `src/vesper/host`.

Vesper may talk to Mortis later through APIs, adapters, curated files, or the Mortis workspace. It must not depend on hidden chat history from another project.

## Architecture rules

```
MODEL → AGENT → PERMISSION SYSTEM → TOOL → RESULT → AGENT → MODEL
```

- The language model never has unrestricted OS authority.
- Every action goes through the tool registry and a deterministic permission gate.
- Permission levels: `read` | `safe` | `confirm` | `never`.
- The model cannot relax permissions. Overrides may only restrict further.
- High-risk tools (`disk_wipe`, credential access, security bypass, dangerous hardware control) are **never autonomous**.
- Tray/host controls cannot bypass that gate to run OS tools.

Core lives in `src/vesper/` (framework-agnostic TypeScript).

## Local-first

After setup, Vesper must operate without cloud AI.

Supported providers (model-agnostic):

1. **Ollama** — local, preferred for model management. Reached through its **native**
   API (`/api/chat`, `/api/tags`, `/api/show`, `/api/ps`, `/api/embed`), not the
   OpenAI-compat shim: the shim hides installed-model metadata, resident VRAM, and the
   token counters that let Vesper report throughput as a measurement instead of a guess.
   The configured endpoint may carry a `/v1` suffix; it is stripped.
2. **llama.cpp** (`http://127.0.0.1:8088/v1`) — local; **Vulkan is the preferred AMD RDNA3 path**
3. **llama.cpp ROCm/HIP** — secondary AMD path (`VESPER_LLAMA_BACKEND=rocm`); discoverable, not assumed faster
4. **Echo** — tests / degraded mode when nothing local is up
5. **Optional cloud (xAI)** — development/preview only, never a production dependency

Do not hard-bind Vesper to one model. Roles: `fast`, `everyday`, `reasoning`, `coding`, `large`.

Do **not** fabricate benchmark numbers. First-boot on the physical PC must discover backends and models, then configure.

## Target hardware (not yet physically validated)

- CPU: AMD Ryzen 9 9950X
- GPU: AMD Radeon RX 7900 XT (20 GB)
- RAM: 96 GB
- OS: Windows

The target machine has been **off** during development. Hardware features are simulated unless `hardware.mode` is live. Never claim physical validation that did not happen.

Use hardware discovery + capability detection. Do not hard-code so Vesper can only run on that PC.

## Optimizer relationship

Adapter interface (`src/vesper/specialists/optimizer.ts`):

- `getStatus` `getTelemetry` `getCurrentProfile` `getPerformanceState`
- `analyze` `requestOptimization` `requestRollback`
- `getLastAction` `getOptimizationResult` `getHealth`

Current implementation: **mock**. A live HTTP adapter exists with timeouts/retries/schema checks for when the real optimizer API is published. Do not invent a fictional production API and mark it complete.

Vesper must never claim an optimization happened unless the adapter returns `accepted: true`.

If the optimizer is down, Vesper still works as an assistant.

## Mortis relationship

Workspace `mortis` exists. Knowledge source `mortis-approved` is opt-in and workspace-scoped. No canon dump.

## Development commands

```bash
npm test          # full suite
npm run typecheck # test files are typechecked too; CI fails on any error
npm run security  # hostile/permission/path tests
npm run hygiene   # secret and repository hygiene
npm run build     # production check (tsc --noEmit)
npm run package   # build dist/vesper-<version>.zip (deterministic)
npm start         # interactive console; background mode when stdin is not a TTY
node --experimental-strip-types src/vesper/host/main.ts --doctor --skip-discovery
```

CI runs on **ubuntu-latest and windows-latest**. Do not write a test that only passes
on Linux; guard platform-specific behaviour explicitly.

Core tests do not require a local LLM.

Windows packaging: `packaging/windows/install.ps1` (not executed in this Linux environment).

## Invariants (each one is a bug that already happened)

Do not undo these. Every line is a defect that shipped, was found, and has a regression
test. The test names say what broke.

- **Config files are merged over defaults, never substituted.** The starter config is a
  *subset*; parsing it standalone let `workspaces: []` win and a real install came up
  with no workspaces, no approved apps, and no knowledge sources.
- **The permission gate default-denies.** Only `read` and `safe` are autonomous. An
  unknown, future, or corrupted level is refused. It must never fall through to allow.
- **Path confinement resolves symlinks.** A lexical `path.resolve` check is defeated by
  a link planted inside an approved directory. Reads, writes, and the knowledge indexer
  all resolve with `realpath` before comparing.
- **A whole user profile is too broad to approve.** `C:\Users\<name>` and `/home/<name>`
  are refused; directories inside them are not. Refusing everything under `C:\Users`
  made the filesystem tools useless on the only OS Vesper targets.
- **Tool results go into history next to the call they answer.** An assistant message
  with unanswered tool calls is a protocol violation; a real backend rejects the next
  turn and the conversation silently degrades to the offline stub.
- **The context window never starts mid-exchange.** A naive tail can open on a tool
  result and orphan it — the same corruption from the other end.
- **Turns are serialized.** Two concurrent turns splice their history mutations
  together and reproduce that corruption.
- **Tool arguments are validated against the advertised schema** before the permission
  gate and before any confirmation is queued. `required` and `enum` are shown to the
  model, so they must mean something.
- **Providers are re-probed lazily.** Probing once at startup meant a backend started
  after Vesper — the normal order when it launches at login — was never noticed.
- **The installer and the runtime must agree on the config path.** They did not, so a
  real install's config was ignored entirely. A test parses the script and asserts it.
- **An audit-log write failure must never reach the process.** It used to arrive as an
  unhandled rejection and take the assistant down.
- **A remote device never reaches OS authority, at any trust class.** A conversation is
  a tool-calling loop, so a device permitted to converse was permitted to call anything
  the agent chose — including filesystem tools on the host's disk. Enforced where tools
  run, not only where capabilities are discussed. A trusted *device* is still a
  different machine.
- **Trust is read live, never cached into a session.** A client session that carried its
  own copy of trust kept working for up to an hour after the user revoked the device.
- **A device is a key, not a label.** Sessions bind to a registered device id. Anyone
  can claim to be called "laptop".
- **Scope rules live in one module.** The store and the sync engine each grew their own
  copy and the copies drifted: `search` hid `user`-scoped memories outside the workspace
  they were recorded in, which is the opposite of what user scope is for.
- **A named device is a constraint, not a preference.** `preferredDevice` falls through
  when the machine is offline. For "prepare my desktop", falling through runs the work
  on hardware the user never asked about and reports success.
- **Retrieved text is data, never instruction.** Tool results, knowledge hits, and
  memory are sealed in a per-wrap nonce boundary the content cannot close. Screening is
  evidence; the boundary and the escaping are what contain an attack, so they apply to
  clean content too.
- **Retrieval envelopes are capped.** `fitContext` cannot trim the system prompt, so an
  unbounded envelope starves history with no way to recover. One long memory took 68% of
  the budget.

## Honesty rules that constrain code, not just prose

- **Never present an estimate as a measurement.** Throughput comes only from
  provider-reported token counters; time-to-first-token only from a genuinely streamed
  reply. Both are `null` otherwise. The context budget is in characters *because*
  Vesper cannot count a backend's tokens.
- **Correlation is not causation.** `explain_change` reports timing and says so.
- **A downgrade is reported, not hidden.** When retrieval falls back from a model
  embedder to lexical hashing, diagnostics names both.
- **"Available" means what it says.** For voice it means Vesper can convert between
  audio buffers and text — never that an audio device works.
- Never claim an optimization happened without `accepted: true` from the adapter.
- **A capability is discovered, never assumed.** A device type does not imply a
  capability; the component that would do the work is asked. `AVAILABLE`,
  `UNAVAILABLE`, and `NOT_CONFIGURED` are three different claims — the last means
  nothing is wired up to answer, and reporting it as `UNAVAILABLE` would imply we
  looked. A mock adapter answering "available" is not the capability.
- **Never claim forensic "zero trace".** No application can promise that about a host it
  does not control. The honest objective is no intentional application persistence plus
  minimized host exposure.

## Important constraints

- Never log passwords, API keys, tokens, or credentials.
- Never silently transmit private memory/files to cloud systems.
- Voice is modular and optional (faster-whisper / Piper / Kokoro).
- Windows tray, startup, and live AMD telemetry are hardware-dependent.
- Idle behavior must stay event-driven and cheap — this PC also games, streams, and runs VR.
- Do not blindly index the whole disk. Knowledge roots must stay inside `approvedRoots`.
- This repository is public. Treat every commit as world-readable.

## Status classification required in reports

Use only: **IMPLEMENTED + TESTED**, **IMPLEMENTED + HARDWARE DEPENDENT**, **MOCKED / SIMULATED**, **DOCUMENTED BUT NOT IMPLEMENTED**, **EXTERNAL BLOCKER**.

A module that is implemented and tested but that nothing calls is **not** IMPLEMENTED +
TESTED at the product level. Say so — "implemented and tested, not wired" — because a
guarantee no call site asks for is not a guarantee the product has. Several modules were
in exactly that state and were found only by sweeping exports for call sites.
