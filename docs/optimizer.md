# Optimizer adapter

The PC optimizer is a **separate product**. Vesper must not reimplement it.

`src/vesper/specialists/optimizer.ts` defines the adapter:

- Mock adapter for development (`mode: mock`) — **MOCKED / SIMULATED**
- HTTP adapter (`mode: live` + endpoint) — waits for the real API — **DOCUMENTED, interface ready, not a live integration**

Vesper should:

- query status/telemetry
- interpret mock/live results honestly
- provide workload context (OBS started, game launched)
- request analysis / optimize / rollback through the adapter
- keep working if the optimizer is down
