# Optimizer adapter

The PC optimizer (NEXUS) is a specialist. Vesper never performs low-level hardware
optimization itself.

Interface (`src/vesper/specialists/optimizer.ts`):

- `getStatus` `getTelemetry` `getCurrentProfile` `getPerformanceState`
- `analyze` `requestOptimization` `requestRollback`
- `getLastAction` `getOptimizationResult` `getHealth`

## Adapters

| Adapter | When selected | Vesper `mode` | Capability classification |
|---|---|---|---|
| Mock | default / `mode: "mock"` / `mode: "off"` | `mock` | `NOT_CONFIGURED` |
| NEXUS IPC | `mode: "live"` + `transport: "ipc"` (or auto when `socketPath` / `pipeName` / `home` set) | `live` | `AVAILABLE` / `UNAVAILABLE` |
| HTTP | `mode: "live"` + HTTP `endpoint` (legacy placeholder) | `live` | `AVAILABLE` / `UNAVAILABLE` |

### NEXUS IPC (preferred)

Speaks the **real** NEXUS contract: Windows named pipe or POSIX unix domain socket,
newline-delimited JSON, **no TCP**. Implementation: `src/vesper/specialists/nexus-ipc.ts`.

Example config:

```jsonc
{
  "optimizer": {
    "mode": "live",
    "transport": "ipc",
    "home": "C:\\Users\\you\\AppData\\Local\\NEXUS"
    // POSIX alternative: "socketPath": "/home/you/.local/state/nexus/runtime/vesper.sock"
    // Optional: "tokenPath": "…/runtime/vesper-token"
  }
}
```

Auth: Vesper reads the shared secret from `<NEXUS home>/runtime/vesper-token` (or
`tokenPath`) and presents it on every request. The token is never logged.

### Method mapping (OptimizerAdapter ↔ NEXUS)

| OptimizerAdapter | NEXUS method | Notes |
|---|---|---|
| `getStatus` | `getStatus` (+ `getCurrentProfile`) | Vesper `mode` stays `live`; NEXUS fidelity is not copied into `mode` |
| `getTelemetry` | `getTelemetrySummary` | Bound inferred from CPU/GPU util metrics when present |
| `getCurrentProfile` | `getCurrentProfile` | |
| `getPerformanceState` | `analyzeWorkload` | Workload class → cpu/gpu/idle/unknown |
| `analyze` | `analyzeWorkload` | Summary carries fidelity caveat when mocked/simulated |
| `requestOptimization` | `optimize` | `profile` → `profileId`; mocked/simulated fidelity never narrated as live hardware change |
| `requestRollback` | `rollback` | Needs `checkpointId` from a prior optimize outcome |
| `getOptimizationResult` | `getOptimizationResult` | Uses last outcome id when known |
| `getHealth` | (via `getStatus`) | Reachability / latency of the IPC client |
| — | `getCapabilities` / `recommend` / `declareContext` / `listProfiles` | Available on the wire; not yet surfaced on `OptimizerAdapter` |

### HTTP (legacy placeholder)

Timeouts, GET retries, JSON validation, and a hard rule that `accepted` must be boolean
`true` before Vesper will say an optimization happened. Malformed `{ "ok": true }` is
**not** confirmation. There is still no published production HTTP optimizer API; prefer
NEXUS IPC.

## Honesty rules

- **Mode is Vesper's provenance**, never taken from the specialist's response body.
- **NEXUS fidelity** (`live` / `mocked` / `simulated` / …) is reported in summaries.
  A mocked optimize must not be described as a live hardware change.
- **`optimizer_request` stays confirm-tier.** NEXUS output cannot grant Vesper authority.
- Cooperation (`src/vesper/specialists/context.ts`): when analysis says GPU-bound, Vesper
  explains that raising CPU is unlikely to help, and can mention OBS/VRChat/game context
  from the host adapter.

## What remains PC-only

Enabling NEXUS on the target Windows PC, granting mutating scopes (`optimize`,
`rollback`, `context`) in NEXUS config, generating the token file, and observing live
AMD telemetry / real actuator effects. Unit tests use a local mock socket server and do
not require a real NEXUS process.
