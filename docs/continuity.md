# Multi-node continuity

Vesper is one assistant across several nodes (main PC, laptop, USB child), not
three independent installs. Local execution stays primary. The cloud is an
optional encrypted continuity layer.

This document is the foothold: interfaces, data contracts, a local mock, tests,
and an honest list of what still needs hardware or a production backend.

## Already present (reused)

- Device identity (ed25519, not a hardware serial)
- Device registry (enrol / trust / revoke / presence)
- Memory scopes and the existing memory `SyncEngine`
- Signed session capsules
- Voice STT/TTS providers (disabled by default)
- Model router and local inference discovery
- Procedure / skill / automation stores
- Deny-by-default permission gate

## New substrate (`src/vesper/continuity/`)

| Piece | Role |
| --- | --- |
| `SyncRecord` | Provider-neutral syncable data. Never an instruction. |
| Privacy classes | `private` (default) / `device_only` / `shared` / `global` |
| Outbox / inbox | Offline-safe, idempotent, checkpointed |
| `CloudSyncProvider` | `authenticate` / `registerDevice` / `push` / `pull` / `revoke` |
| Envelope crypto | AES-256-GCM + HKDF. Mock cloud stores ciphertext. |
| Conversation continuity | Compact handoff. Not a transcript dump. |
| Current-state memory | CURRENT / SUPERSEDED / DISPUTED / ARCHIVED |
| Procedure → skill bridge | Active procedure may become a *scanned* skill. Never auto-enabled. |
| Portable layout | `VESPER_PORTABLE_ROOT` wins over LOCALAPPDATA |
| Wake-word foothold | Disabled. Opens no microphone. |
| Model descriptors | Device-class hints. No hard-coded machine map. |
| Backup / restore | Versioned, hashed, optionally encrypted |

## Security non-negotiables

- Cloud data cannot bypass the local permission gate.
- Sync cannot execute tools.
- Untrusted content stays untrusted through summarisation and sync.
- Revoked devices cannot sync.
- Disabled voice providers capture nothing.
- Mock NEXUS is never reported live.
- Default personal memory does not become globally shared because sync is on.

## Deferred (not faked)

- Physical Windows target validation of USB residency
- Production cloud credentials / hosted backend
- Durable key storage and reviewed E2EE
- Real pairing transport (this module has the offer/accept state machine only)
- Live NEXUS control API
- Microphone / WASAPI / wake-word hardware
- Mobile hardware
- UI for pairing and conflict resolution

## Config

```json
{
  "sync": { "enabled": false, "provider": "none", "privacyDefault": "private" },
  "voice": { "enabled": false, "wakeWord": { "enabled": false } }
}
```

A USB node:

```
set VESPER_PORTABLE_ROOT=E:\vesper
```

Identity keys stay in that root. They are not copied onto arbitrary media by this code.
