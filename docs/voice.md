# Voice

Voice is optional. Vesper runs fully without a microphone or speakers, and the text
interface is never degraded by voice being absent.

## Where the line sits

Converting **an audio buffer to text**, and **text to an audio buffer**, is software.
It is implemented and tested against a fake binary, including argv safety.

Opening a **microphone** or a **speaker** is hardware. Vesper does neither, anywhere.
`available()` means "can convert buffers", never "an audio device works".

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

Wake word is deliberately out of scope for the MVP.

Classification: **IMPLEMENTED + TESTED** for buffer conversion, provider discovery, and
the session state machine. **DOCUMENTED BUT NOT IMPLEMENTED** for physical audio.
