# Multi-node continuity

Vesper is one assistant across several nodes (main PC, laptop, USB child), not
three independent installs. Local execution stays primary. The cloud is an
optional encrypted continuity layer.

This document is the Phase III substrate: one Vesper identity, a pairing
ledger independent of device trust, restart-safe outbox/keyring, a Cloudflare
stub that is not live, and an honest list of what still needs hardware or a
production backend.

## Already present (reused)

- Device identity (ed25519, not a hardware serial)
- Device registry (enrol / trust / revoke / presence)
- Memory scopes and the existing memory `SyncEngine`
- Signed session capsules
- Voice STT/TTS providers (disabled by default)
- Model router and local inference discovery
- Procedure / skill / automation stores
- Deny-by-default permission gate
- `assembleContext` in the agent loop
- Durable jobs on `TaskScheduler`

## Substrate (`src/vesper/continuity/`)

| Piece | Role |
| --- | --- |
| `VesperIdentity` | User-level identity. Never holds a private key. Cloud never required. |
| `DeviceIdentity` | Per-node ed25519 body. Unchanged. |
| Pairing ledger | `pending` / `trusted` / `suspended` / `revoked`. Independent of registry trust. |
| `restricted` | Portable/USB class on the registry. Not a synonym for suspended. |
| `SyncRecord` | Provider-neutral syncable data. Never an instruction. |
| Privacy classes | `private` (default) / `device_only` / `shared` / `global` |
| Demotion | SHARED/GLOBAL → PRIVATE/DEVICE_ONLY emits a retraction tombstone. Local copy stays. |
| Outbox / inbox | Offline-safe, idempotent, checkpointed, persisted across restart |
| `CloudSyncProvider` | `authenticate` / `registerDevice` / `push` / `pull` / `revoke` |
| Envelope crypto | AES-256-GCM + HKDF. Keyring keeps previous versions so rotation does not orphan envelopes. |
| Conversation continuity | Compact handoff. `compactRecentContext` is not a transcript dump. |
| Current-state memory | CURRENT / SUPERSEDED / DISPUTED / ARCHIVED |
| Skill proposals | Hash-bound propose / apply / rollback. Apply is not enable. Stale if hash changes. |
| Browser / desktop seams | Disabled. `openedDevice: false`, `executed: false`. |
| Availability vocab | live / available / mock / stub / disabled / unavailable / blocked / requires_hardware / requires_credentials |
| Cloudflare stub | `cloudflare-stub`. `live: false`. Requires credentials. |
| Portable layout | `VESPER_PORTABLE_ROOT` wins over LOCALAPPDATA |
| Wake-word foothold | Disabled. Opens no microphone. |
| Model descriptors | Device-class hints. No hard-coded machine map. |
| Backup / restore | Versioned, hashed, optionally encrypted, provider-independent |

## Security non-negotiables

- Cloud data cannot bypass the local permission gate.
- Sync cannot execute tools.
- Untrusted content stays untrusted through summarisation and sync.
- Revoked and suspended devices cannot sync.
- `restricted` does not mean suspended.
- Disabled voice providers capture nothing.
- Mock NEXUS is never reported live.
- Cloudflare stub is never reported live.
- Default personal memory does not become globally shared because sync is on.
- A skill proposal never enables a skill.
- Instincts are never policy.

## Intended Cloudflare mapping (not deployed)

- D1 = metadata / index / control state
- R2 = encrypted payload blobs
- Durable Objects = per-user / device sync coordination
- Queues = retry-safe background work

The core stays provider-neutral. Local operation does not need Cloudflare.

## Deferred (not faked)

- Physical Windows target validation of USB residency
- Production cloud credentials / hosted backend
- Durable key storage and reviewed E2EE
- Real pairing transport (offer/accept tools exist; no network listener)
- Live NEXUS control API
- Microphone / WASAPI / wake-word hardware
- Mobile hardware
- Browser / desktop computer-use implementations

## Config

```json
{
  "sync": { "enabled": false, "provider": "none", "privacyDefault": "private" },
  "voice": { "enabled": false, "wakeWord": { "enabled": false } }
}
```

`provider` may be `none`, `local-mock`, or `cloudflare-stub`. Stub is not a
connection.

A USB node:

```
set VESPER_PORTABLE_ROOT=E:\vesper
```

Identity keys stay in that root. They are not copied onto arbitrary media by this code.

## Migration

Current implementation: JSON records in the existing storage adapter, plus an
encrypted envelope for anything that may leave the device.

Future implementation: only if actual requirements justify a different store
(SQLite/CRDT/etc.). The sync abstraction is independent of the storage backend
so a later migration is a provider swap, not a kernel rewrite.

No storage rewrite is in flight.
