# Voice

Voice is optional. Vesper runs fully without a microphone or speakers, and the text
interface is never degraded by voice being absent.

## Where the line sits

Converting **an audio buffer to text**, and **text to an audio buffer**, is software.
It is implemented and tested against local-process boundaries, including argv safety.

Opening a **microphone** or a **speaker** is hardware. Vesper now has an explicit Windows
audio boundary for both: FFmpeg/DirectShow capture and ffplay playback. The adapter is still
hardware dependent until the target PC successfully captures and plays real audio.
`available()` continues to describe conversion capability; `audioAvailable()` separately
describes discovered physical audio I/O.

## Backends

Local backends are driven as subprocesses against their documented CLIs:

- **STT** — `whisper-ctranslate2` / `faster-whisper` / `whisper`, called as
  `<binary> <audio> --model <name> --output_format txt --output_dir <dir>`
- **TTS** — `piper`, taking text on **stdin** with `--model` and `--output_file`

Binary name, model, language, and extra arguments come from config
(`voice.sttModel`, `voice.ttsModel`, `voice.sttArgs`, `voice.ttsArgs`), so a different
local build can be pointed at without a code change.

`src/vesper/voice/process.ts` owns the whole subprocess surface: argv arrays with
`shell: false`, NUL bytes refused before reaching the OS, bounded output capture,
timeouts, and cancellation. A test feeds hostile text through the TTS path and asserts
it arrives verbatim, never shell-expanded.

## Session

`createVoiceSession` implements push-to-talk hold/release, interruption, and fallback to
text. Push-to-talk is a boolean preference (`voice.pushToTalk`); binding an actual
Windows hotkey is HARDWARE DEPENDENT and not applied here.

Wake-phrase activation is implemented as an opt-in local loop. It is STT-backed rather than a dedicated low-power DSP detector; a dedicated openWakeWord/ONNX backend can replace that detector later without changing the audio or agent boundary.

Spoken confirmations are supported: when a voice turn queues a confirm-tier action, the next wake-phrase command `yes/approve/do it` or `no/cancel` is routed through the same confirmation path as the text interface.

Classification: **IMPLEMENTED + TESTED** for buffer conversion, provider discovery, physical-audio orchestration, session capture/playback, wake-phrase orchestration, and spoken confirmation routing. **IMPLEMENTED + HARDWARE DEPENDENT** for real microphone/speaker operation on the target Windows machine.
