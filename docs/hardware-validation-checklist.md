# Hardware validation checklist — target PC

Vesper's target machine is **Ryzen 9 9950X · RX 7900 XT (20 GB VRAM) · 96 GB RAM ·
Windows**. This file lists exactly what each first-boot probe must verify on that
machine before its result can be trusted. It exists so no probe silently claims
success without actually reading real hardware, and so the honest failure mode
("this probe is not implemented on this platform, validate on the target PC")
appears on every non-Windows / non-target host until the physical validation has
been done.

Every item here is a probe id (matches `src/vesper/hardware/probes.ts`) with the
exact test the implementation must pass. Do not mark a probe green until it has
been observed on the physical target PC.

## How to register a real probe

The registry is consulted by first boot — its answers replace the placeholder text in
`--first-boot-report`, so a probe that works changes what a user sees. Two rules, both
of which used to be traps:

1. **Register with `platforms: ["win32"]` and WITHOUT `fallback: true`.** The
   placeholders are marked `fallback`, and a real probe outranks a fallback regardless
   of registration order. Before that flag existed, priority was insertion order alone
   and the placeholders declared `win32` among their platforms — so a correctly written
   Windows probe registered after `registerPlaceholderProbes` would never have run, and
   first boot would have reported "not implemented" on the one machine where it *was*.

2. **The probe id is not the step id.** Probes are `gpu.live`, `vram.live`,
   `telemetry.amd`, `audio.wasapi`, `windows.tray`, `benchmark.harness`; the first-boot
   steps they feed are `gpu`, `vram`, `telemetry`, `audio`, `windows`, `benchmark`. The
   mapping lives in one table in `bootstrap.ts`. Use the dotted probe ids here.

A probe must not throw — a throw is reported as a probe failure rather than a hardware
answer — and must return a `classification`, not just `ok`. A **negative** answer is
kept as-is: "the probe ran and could not read the GPU" is a different fact from "no
probe exists", and flattening them makes a broken driver look like an unasked question.

The mission's rule "**do NOT fabricate benchmark numbers before the machine
exists**" applies to every item below. A number without a real measurement on
real silicon is not a number; it is an assumption.

---

## `gpu.live` — live GPU identity

**Runs on**: Windows (win32). Fallback returns "not implemented" everywhere else.

**Must verify**:
- The GPU driver reports the device as *AMD Radeon RX 7900 XT*.
- The bus id, driver version, and driver build date are all populated.
- If a second GPU is present (integrated), it is enumerated separately, not
  substituted for the RX 7900 XT.

**Rejection cases**:
- The name string contains "Software", "Basic", "Microsoft", or "Generic".
- The device id does not match the RX 7900 XT PCI id family.

**Where to look**: DXGI (`IDXGIFactory::EnumAdapters1`), AMD ADLX, or WMI
`Win32_VideoController`. Pin the exact source in the probe implementation.

---

## `vram.live` — live VRAM totals

**Runs on**: Windows (win32).

**Must verify**:
- Total dedicated video memory reads as **20 GB** (±0.5 GB tolerance for driver
  reservations).
- Shared system memory is reported separately from dedicated.
- The reading is stable across three back-to-back probes (a driver that flickers is
  a probe that cannot be trusted).

**Rejection cases**:
- Total dedicated VRAM below 18 GB (indicates a driver failure, resource
  overallocation, or a different GPU is being read).

---

## `telemetry.amd` — AMD ADLX / ADL live telemetry

**Runs on**: Windows only, and only after AMD's ADLX (or legacy ADL) is available
on the machine.

**Must verify**:
- Current GPU clock (MHz) is a plausible RDNA3 value (300–3000 MHz).
- Current GPU temperature (°C) is a plausible value (25–110 °C).
- Board power draw (W) is bounded by the RX 7900 XT TBP (315–355 W nominal).
- Values change over time — a probe that reports the same number for 60 s is
  reading a snapshot, not a live sensor.

**Rejection cases**:
- Any value reads a documented sentinel (0xFFFF, NaN, MIN_INT).
- ADLX / ADL is not present on the machine — the probe must fail cleanly with
  `ok: false, reason: "ADLX not installed"`, not fabricate a number.

**Important**: this probe is the seam Vesper uses to distinguish live NEXUS
observations from simulated ones. A wrong reading here silently corrupts
optimizer telemetry, so every field must be independently sanity-checked.

---

## `audio.wasapi` — audio device enumeration

**Runs on**: Windows only.

**Must verify**:
- At least one active render endpoint (speakers/headphones).
- At least one active capture endpoint (microphone) if any device is enrolled.
- Endpoint state matches the OS's own reporting (Sound Control Panel).

**Rejection cases**:
- The probe returns endpoints marked *disabled* or *unplugged* as "available".
- Enumeration returns default-devices only, missing the full list.

---

## `windows.tray` — tray + startup registration

**Runs on**: Windows only.

**Must verify**:
- Tray icon registers via the system tray API; a click produces a menu.
- Startup registration (Run key or Task Scheduler entry) can be written AND read
  back — a probe that writes without reading has proven nothing.
- Deregistration removes the entry cleanly.

**Rejection cases**:
- Tray icon disappears within 5 s (indicates a lifecycle bug in the shell).
- Startup entry is written but does not survive an OS restart (test only after a
  real restart, not a probe-and-remove cycle).

---

## `benchmark.harness` — model benchmark with a real backend

**Runs on**: any platform, but only when a local backend is actually generating
tokens. **DO NOT** run this as part of the standard first-boot pass — it takes
time and demands hardware.

**Must verify**:
- Time-to-first-token (TTFT) is measured against a warmed, resident model, not a
  cold-loaded one.
- Throughput (tokens/second) is measured over a token count large enough to
  average out first-batch cost — 128 tokens minimum for a small model, more for
  larger.
- The measurement is repeated at least 3 times; the median is reported, not the
  best.
- The model id, quantisation, and backend id are all recorded alongside the number.

**Rejection cases**:
- Any TTFT/throughput reported when no backend was actually invoked.
- A number recorded without the model id, quantisation, or backend id.
- A number recorded from a single run (variance too high to trust).

The mission's rule is absolute: **do NOT fabricate benchmark numbers before the
machine exists**. This probe is the enforcement point.

---

## Not covered by these probes

- Real *live* Windows toast notifications, tray, and startup — the `windows.tray`
  probe only verifies enumeration/registration, not delivery.
- Real *live* NEXUS integration (the specialist optimizer). That is an entirely
  separate boundary; see `security/BACKLOG.md` §1 and `docs/architecture-seams.md`.
- USB continuity on a foreign host — that requires a second physical machine.

These wait for their own campaigns.

---

## When to update this file

- When a new probe id is added: append a section with the exact "must verify"
  and "rejection cases".
- When a probe's implementation lands: add a line stating what commit installed
  it and what the observed value was on the target PC.
- Do not remove a rejection case just because a real measurement produced a value
  outside the range — first check the machine.
