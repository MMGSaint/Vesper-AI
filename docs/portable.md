# Portable Vesper

Vesper carried on removable media and run on a computer that is not the user's.

This document is the trust model and the threat model. It is deliberately ahead of the
deployment work: the interfaces, identity, capability model, auth model and session
model exist and are tested; packaging and installation do not, and are not attempted
here.

## The two trust classes, stated first

Everything else follows from these:

- **The USB device is `RESTRICTED`.** It authenticates as the user's device, and it is
  still not a machine whose surroundings Vesper can vouch for.
- **The host PC is `UNTRUSTED`.** Not "less trusted". Untrusted. It may be running a
  keylogger, a screen recorder, a hostile clipboard manager, or a modified Node runtime,
  and Vesper has no way to find out.

The second is the harder one to hold onto, because the host is also the thing executing
Vesper's own code. That is precisely why portable Vesper asks a trusted device to act
rather than acting itself.

## Not a separate system

Portable Vesper uses the same identity, memory model, task system, presence, registry,
protocol, and permission semantics as every other device. It is a **trust class and a
capability restriction on the device model**, not a parallel product.

A second, portable-only protocol would be the real risk here. Two authorization paths
means two places to get it right and one to forget — and the forgotten one is always the
one that ships. So: one contract, one registry, one permission gate.

Concretely, a portable session is a `restricted` device on a `foreign` host:

| | Trusted device | Portable (restricted, foreign host) |
|---|---|---|
| Converse | yes | yes |
| Read status | yes | yes |
| Read knowledge | yes | yes |
| Read memory | yes | **no** |
| Write memory | yes | **no** |
| Approve a confirmation | yes | **no** |
| Execute tasks for others | yes | **no** |
| Create tasks | yes | yes |
| Filesystem, Windows control | never remotely | never |

Two of those deserve their reasons. A restricted device does not **approve** anything,
because an approval is the user's authority and a foreign host may be watching the
screen it is approved on. And a foreign host does not **execute** other devices' tasks:
it may ask for work to be done elsewhere, it must not become the machine that does it.

## What portable Vesper must never do

These are absolute. They are not configurable, and no policy, model output, host
condition, or remote instruction relaxes them.

- No administrator or elevated privileges.
- No arbitrary filesystem access on the host.
- No arbitrary process execution.
- No registry modification.
- No access to credential stores, browser passwords, cookies, SSH keys, or crypto
  wallets.
- No persistence: no service, no scheduled task, no startup entry, no registry run key.
- **No inbound listener and no raw LAN command tunnel on a foreign host.** A listening
  socket on someone else's machine is an attack surface that outlives the session and
  that its owner never agreed to.
- No automatic control of the host. Portable Vesper does not act on the machine it is
  borrowed on.

## Credentials

Short-lived and revocable. A portable session carries a signed grant with a bounded TTL
(30 minutes by default, 12 hours maximum), a nonce checked against a replay guard, and a
**live** trust check on the issuing registry — so revoking the stick's device id ends
every session it holds immediately, not whenever the grant expires.

The private key stays on the stick and is never transmitted. A grant proves possession;
it never carries the thing it proves.

## Data minimization

Portable Vesper never downloads the memory store. It requests what a query needs and
nothing more, and `restricted` devices do not hold `memory.read` at all — a portable
session that needs a stored fact asks a trusted device, which answers the question
rather than handing over the record.

The reasoning: whatever reaches the foreign host may be captured. The defence that
actually works is not encrypting it in transit — it is not sending it.

## Traces, stated honestly

**Vesper does not claim forensic "zero trace".** That claim cannot be made truthfully by
an application about a host it does not control. An operating system writes prefetch
entries, event logs, USN journal records, shellbags, and thumbnail caches without asking
the program that triggered them, and a hostile host can record anything it likes.

The honest objective, and the one actually engineered for, is:

- **no intentional application persistence** — Vesper installs nothing, registers
  nothing, and schedules nothing on the host; and
- **minimized host exposure** — no credential access, no writes outside the removable
  volume, no listener, and the smallest possible amount of user data present on the host
  at any moment.

Anyone who needs a genuine no-trace guarantee needs a different threat model and
probably different hardware. Saying so is more useful than a reassurance that would not
survive contact with a forensic examiner.

## Threats and what answers them

| Threat | Answer |
|---|---|
| Host reads the stick's private key | Key never leaves the stick; grants prove possession without carrying it |
| Host replays a captured grant | Nonce + replay guard + bounded TTL |
| Stick is lost | Revoke the device id; every session dies on the next request, not at expiry |
| Host keylogs the session | Data minimization; no memory read; no approvals from this class |
| Host tries to reach the user's other machines | `restricted` grants exclude execution; OS authority is never remote at any class |
| Hostile content on the host (documents, clipboard, web) | Treated as untrusted data: sealed in a boundary the content cannot close, screened, and withheld when it scores high |
| Malicious host modifies Vesper's own code | **Not defended.** Out of scope, and stated rather than papered over — code executing on a hostile machine can be changed by that machine. |

That last row is the honest limit of this design. Portable Vesper protects the user's
*other* devices and the user's *data* from a hostile host. It cannot protect its own
execution on that host.

## Not built

- Packaging for removable media, and the launcher that would start it.
- Windows isolation (AppContainer, Windows Sandbox, MSIX) — researched as an option, not
  implemented, and not claimed.
- Any deployment or installation flow.

Per the add-on brief, the interfaces, trust model, identity, capability model, auth
model, portable session model, tests, and this document come first; deployment follows.
