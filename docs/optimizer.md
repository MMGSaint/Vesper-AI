# Optimizer adapter

The PC optimizer is a specialist. Vesper never performs low-level hardware optimization itself.

Interface (`src/vesper/specialists/optimizer.ts`):

- `getStatus` `getTelemetry` `getCurrentProfile` `getPerformanceState`
- `analyze` `requestOptimization` `requestRollback`
- `getLastAction` `getOptimizationResult` `getHealth`

Mock adapter: **MOCKED / SIMULATED**. Used by default.

HTTP adapter: timeouts, GET retries, JSON validation, and a hard rule that `accepted` must be boolean `true` before Vesper will say an optimization happened. Malformed `{ "ok": true }` is **not** confirmation.

There is still no published production optimizer API. Do not invent one.

Cooperation (`src/vesper/specialists/context.ts`): when analysis says GPU-bound, Vesper explains that raising CPU is unlikely to help, and can mention OBS/VRChat/game context from the host adapter. That context is simulated until the target PC is on.

`optimize this` remains confirmation-gated.
