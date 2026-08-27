# Vesper across devices

Vesper is one assistant, not three installations that happen to share a name. This
document describes how a desktop, a laptop, and a phone become that — and, just as
importantly, which parts are built and which are not.

Nothing here is a plan. Every mechanism described is implemented and tested unless the
section says otherwise, and the sections that say otherwise say it plainly.

## Identity: a device is a key, not a name

A device's identity is an ed25519 keypair generated on first run and stored under the
data directory. The device id is derived from it. The private half never syncs, never
appears in a log, and is never exported; the stored key is verified with a signature
self-test before Vesper will trust it, so a corrupted or tampered key file is detected
rather than used.

A name is not an identity. `deviceLabel` is a convenience for humans reading a list. It
is not authenticating anything, because anyone can claim to be called "laptop".

Hardware fingerprints are deliberately **not** used. They are spoofable, they change
when a user upgrades a disk, and they leak hardware details into a value that gets
transmitted. A keypair the device must actually possess is both stronger and quieter.

## Trust: a state the user sets, that the system reads live

```
unknown ─enrol→ pending ─approve→ trusted ⇄ restricted
                   │                 │           │
                   └────── revoke ───┴───────────┘
                                     ↓
                                  revoked  (terminal)
```

- **pending** — Vesper has seen this device. It gets nothing. A device does not become
  trusted by asking.
- **restricted** — admitted, but its surroundings cannot be vouched for. This is the
  portable/USB class; see [portable.md](portable.md).
- **trusted** — the user's own machine, approved at the machine.
- **revoked** — terminal. A revoked identity cannot re-enrol, because revocation that
  can be undone by reconnecting is not revocation.

Trust is read at the moment of every request, never cached into a session. That is what
makes revocation immediate: a phone the user has declared lost stops working when they
revoke it, not whenever its token happens to expire. Demotion behaves the same way — a
session opened while a device was trusted is re-capped the instant it becomes
restricted, so it cannot outlive the trust it was opened under.

## Capabilities: discovered, never assumed

A capability manifest answers "what can this device actually do, right now" by asking
the component that would do the work. A laptop with no reachable model backend does not
have `local_llm`, however much it looks like a machine that should.

Three states, which are three different claims and are never collapsed:

| State | Meaning |
|---|---|
| `AVAILABLE` | Asked, and it answered yes. |
| `UNAVAILABLE` | Asked, and it answered no, or could not be reached. |
| `NOT_CONFIGURED` | Nothing is wired up to answer at all. |

The last one matters. Reporting an unbuilt feature as `UNAVAILABLE` would imply we
looked. A probe that throws yields `UNAVAILABLE` **with the reason attached** rather
than quietly dropping the capability — "we could not tell" and "it is not there" are
different answers and Vesper reports which one it has.

One case is worth stating because it was a real bug: the mock optimizer adapter answers
`available: true`, because it is a working mock. Reporting that as the `nexus`
capability would let a peer route real optimization work to a machine that can only
pretend to do it. The probe requires `mode: "live"`.

## What a remote device may reach

Two separate questions, never conflated:

1. **What can this device do?** → the manifest, discovered above.
2. **What may another device ask of it?** → the grant, decided by the requester's trust
   class.

A grant is a **ceiling, never a permission**. Everything still passes the local
permission gate afterwards; a grant can only narrow what the gate would allow. The
model, a remote device, an MCP server, NEXUS, and the UI are all structurally incapable
of widening it. Only configuration can.

Some capabilities are refused at every trust class, including `trusted`, because a
trusted *device* is still a different machine:

- `filesystem`
- `windows_control`
- device trust administration — a device that can change trust states can promote
  itself, which turns one stolen phone into permanent access.

This is enforced at the point tools actually run, not only where capabilities are
discussed. That distinction was a real hole: a conversation is a tool-calling loop, so
a device permitted only to converse was, in practice, permitted to call anything the
agent decided to call.

## Memory scopes

Five scopes, with visibility and syncability defined in exactly one module so the store
and the sync engine cannot drift apart:

| Scope | Reaches disk | Reaches other devices | Meaning |
|---|---|---|---|
| `session` | no | no | This conversation only. |
| `device` | yes | yes | A fact about one machine. |
| `workspace` | yes | yes | Scoped to a workspace. |
| `user` | yes | yes | About the person; follows them everywhere. |
| `global` | yes | yes | True regardless of context. |

A device-scoped fact about another machine is **not hidden** — Vesper may need to say
"your desktop has a 7900 XT" while running on the laptop — but it is always attributed
to the device it belongs to. Stating it bare is how one machine's hardware silently
becomes a claim about another. When Vesper cannot tell which device is asking, it
declines to attribute rather than guessing.

`user` scope exists precisely so a fact follows the person across contexts. A
preference stated in one workspace must not vanish in another.

## Conflict resolution

Blanket last-write-wins loses data and does it silently. Instead:

- Device facts about **different machines** are never merged. They are not competing
  claims about one thing; they are two facts.
- A higher revision wins over a lower one.
- Equal revisions that disagree produce a **conflict**, surfaced rather than resolved by
  coin-flip.
- Secrets are filtered on the way out *and* on the way in, so a peer cannot push one in
  either direction.

## Tasks

Tasks are persistent and cross-device. Routing never degrades onto a device that lacks
what the task needs, and execution requires `trusted` — a restricted device can create
work and watch it, but running it would put execution on a host that cannot be vouched
for. A task caught mid-`running` when Vesper restarts is requeued rather than presumed
finished.

Naming a device is a **requirement, not a hint**. "Prepare my desktop for VRChat" said
from the laptop is not a request to do something to the laptop, so a named device is
recorded as a hard constraint on the task. If it is offline, untrusted, or not enrolled,
Vesper says so instead of substituting another machine and reporting success.

## The client protocol

`vesper.client` v2. A session is bound to a **registered device id**, not to a label,
and every request re-reads trust from the registry.

There is deliberately only one contract. A phone on the sofa, a laptop in another room,
and Vesper running from a USB stick on a foreign PC are the same kind of thing — a
device with an identity, a trust state, and a capability manifest. They differ by trust
class, not by protocol.

## Not built

Stated plainly rather than described in the present tense:

- **No transport.** The gateway is in-process. There is no pairing flow, no listener, no
  LAN TLS. Opening an inbound network listener on a personal machine is an
  outward-facing security decision that belongs to the machine's owner, not to an agent
  working unattended.
- **Sync engine is not attached.** `SyncEngine`, conflict resolution, and sync filtering
  are implemented and tested, but nothing calls them, because calling them requires the
  transport above. Capability discovery reports `sync` as `NOT_CONFIGURED` for exactly
  this reason, on every device, today.
- **Session grants are not issued.** The signed, replay-guarded grant model for portable
  sessions exists and is tested; the companion path currently uses device-bound client
  sessions instead.
- **No mobile client application.** The protocol a phone would speak is defined; the
  phone application is not written.
- **Presence is local.** A device records its own presence. Nothing heartbeats between
  machines, again because there is no transport.
