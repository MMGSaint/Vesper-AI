        data: report as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("voice_status", "Read optional voice module status.", "read", {}),
    async () => {
      const status = voiceSession?.diagnostics() ?? voice?.status() ?? {
        enabled: false,
        stt: "none",
        tts: "none",
        available: false,
        audioAvailable: false,
        pushToTalk: false,
        speakResponses: true,
        detail: "Voice module not attached.",
      };
      return {
        ok: true,
        epistemic: "checked",
        summary: "detail" in status ? status.detail : "Voice status.",
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "voice_capture",
      "Capture one microphone utterance and transcribe it locally. Requires explicit confirmation because it opens the microphone.",
      "confirm",
      {},
    ),
    async () => {
      if (!voice?.audio) {
        return { ok: false, epistemic: "could_not_access", summary: "Physical audio is not available." };
      }
      const captured = await voice.audio.captureWav(voice.captureSeconds);
      if (!captured.available || !captured.audio) {
        return { ok: false, epistemic: "could_not_access", summary: captured.detail };
      }
      const transcript = await voice.stt.transcribe(captured.audio);
      if (!transcript.available || !transcript.text.trim()) {
        return { ok: false, epistemic: "could_not_access", summary: transcript.detail };
      }
      return {
        ok: true,
        epistemic: "checked",
        summary: transcript.detail,
        data: { transcript: transcript.text.trim() } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("diagnostics_report", "Generate a Vesper health and diagnostics report.", "read", {}),
    async () => {
      if (!getDiagnostics) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: "Diagnostics collector is not attached.",
        };
      }
      const report = await getDiagnostics();