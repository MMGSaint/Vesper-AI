# Client protocol

Classification: **IMPLEMENTED + TESTED** for the in-process contract.
Network transport, pairing UX, and TLS on the LAN are **DOCUMENTED BUT NOT IMPLEMENTED**.

## Why this exists

Vesper Mobile is a companion. Vesper-AI is the local-first core.

```
VESPER CORE
     │
     ├─ Windows host
     └─ Android companion
```

Clients must not become authorities. A connected phone cannot:

- relax permissions
- run shell/filesystem/subprocess tools
- mutate the optimizer
- treat transport as authorization

## Version

- Protocol id: `vesper.client`
- Version: `1`
- In-process gateway: `src/vesper/client/`
- Production host exposes `host.gateway` and `--client-hello`
- No token is printed by `--client-hello`

## Scopes

| Scope | Meaning |
| --- | --- |
| `status` | Honest capability report |
| `conversation` | Chat through the agent loop |
| `memory.read` / `memory.write` | Persistent memories only |
| `knowledge.read` | Approved-root search |
| `notifications` | Recent notices |
| `operator.confirm` | Approve or deny a pending confirmation |

Remote companions never receive `os.filesystem`, `os.subprocess`, `os.shell`, `optimizer.mutate`, `permissions.relax`, or `security.disable`.

## Capability states

Clients must display exactly:

`AVAILABLE` | `UNAVAILABLE` | `DEGRADED` | `NOT_CONFIGURED`

Examples:

- Local Ollama/llama.cpp down → `local-model = NOT_CONFIGURED`
- Mock optimizer only → `optimizer = DEGRADED`
- Voice interfaces without hardware validation → `voice = UNAVAILABLE`
- Remote OS control → always `UNAVAILABLE`

## Sessions

Sessions are issued by the host. Tokens expire (default 15 minutes). Scope checks use the session, not the network path.

A later transport must be authenticated, encrypted, scoped, audited, and versioned. Until that exists, the gateway is the contract Mobile can target.

## Mortis

Mortis remains a workspace. The client protocol reports that workspace as scoped knowledge, not as canon authority.
