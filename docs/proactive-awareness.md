# Proactive awareness

Vesper has a background Sentinel layer separate from normal chat.

It observes NEXUS optimizer telemetry on a quiet loop, requires repeated evidence before issuing ordinary alerts, and routes visible output through the existing notification/event audit path. The Sentinel does not start a microphone or capture device.

Current observations include optimizer availability, CPU/GPU pressure, GPU temperature, VRAM pressure, and coarse CPU-vs-GPU bound inference. The design is deliberately evidence-first: missing telemetry produces an honest "I don't know" state rather than a guessed machine state.

The next WARDEN inputs are frame-time telemetry from PresentMon, VR compositor/session state from OpenXR, Windows crash/TDR evidence, and explicit desired-vs-observed game profiles.

The intended lifecycle remains:

observe -> correlate -> assess significance -> explain -> propose/act

Safe observations can be automatic. Any world-changing action still goes through Vesper's permission governor.
