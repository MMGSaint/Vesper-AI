# Voice

Voice is optional. Vesper runs fully without a microphone or speakers.

Planned local providers:

- STT: faster-whisper
- TTS: Piper (default) or Kokoro

Interfaces live in `src/vesper/voice/`. A simulated provider exists for tests. Live capture/playback was **not** opened in this environment.

Push-to-talk is a boolean preference (`voice.pushToTalk`). Keyboard shortcut binding on Windows is **IMPLEMENTED + HARDWARE DEPENDENT** / not applied here.

Classification: **DOCUMENTED BUT NOT IMPLEMENTED** for physical audio; **IMPLEMENTED + TESTED** for the disabled/simulated module.
