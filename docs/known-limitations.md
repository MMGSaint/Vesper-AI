# Known limitations

## Hardware, unchanged

The target Windows PC (Ryzen 9 9950X / RX 7900 XT 20 GB / 96 GB) was powered off for
all of this work. Nothing below has been observed on it.

- No live AMD telemetry, clocks, power, or temperatures.
- No local-model throughput on the target PC. The benchmark harness reports throughput
  only from provider-reported token counters and time-to-first-token only when a reply
  genuinely streamed; it refuses to estimate either. **No number in this repository
  came from that machine.**
- No Windows command has been executed: `tasklist`, application launch and close, the
  HKCU startup entry, and toast notifications are implemented and unit-tested against a
  fake runner, never run.
- The tray has never displayed an icon. The mechanism is chosen and the protocol is
  implemented; `Shell_NotifyIcon` needs Windows.
- Voice converts audio buffers to text and text to audio buffers, tested against a fake
  binary. Vesper opens no microphone and no speaker.
- The installer, uninstaller, and reset scripts have not been run on Windows.

## Not implemented

- **MCP client.** `integrations/mcp.ts` reports configuration status. It is not an MCP
  client, it speaks no JSON-RPC, and it contacts no server.
- **OBS WebSocket.** OBS state is inferred from process presence, and reported as
  inferred rather than observed.
- **Companion transport.** `vesper.client` v1 is in-process only. There is no pairing,
  no listener, and no LAN TLS.
- **Wake word.** Deliberately out of scope; push-to-talk is the activation model.

## Real, and worth knowing

- **Retrieval without an embedding backend is lexical.** With a local embedding model
  reachable, retrieval is hybrid. Without one it falls back to BM25 and says so in
  diagnostics. Lexical retrieval cannot match a question that shares no words with the
  stored text: "when do I usually go live?" will not find "I stream on Friday nights"
  until a real embedding model is running.
- **The context budget is measured in characters, not tokens.** Vesper cannot count a
  backend's tokens without asking it, and will not present an estimate as a
  measurement. The budget is used for trimming only.
- **The optimizer is a mock.** Its contract is a placeholder until the real API is
  published. Vesper never claims an optimization happened without an authoritative
  `accepted: true` from the adapter.
- **Correlation is timing, not causation.** `explain_change` reports what Vesper
  observed near a moment and says explicitly that this does not prove one thing caused
  another.
- **A whole user profile cannot be an approved root.** `C:\Users\<name>` and
  `/home/<name>` are refused as too broad; directories inside them are fine.

## What to do when the PC is on

Run the host, read the first-boot report, and treat every hardware-dependent item above
as unfinished until it has actually succeeded on that machine. See
`docs/first-boot.md`.
