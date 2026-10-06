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
      if (!voiceSession) {
        return { ok: false, epistemic: "could_not_access", summary: "Voice session is not attached." };
      }
      const hold = voiceSession.holdPtt();
      if (!hold.ok) return { ok: false, epistemic: "could_not_access", summary: hold.summary };
      const result = await voiceSession.releasePtt();
      return {
        ok: result.ok,
        epistemic: result.ok ? "checked" : "could_not_access",
        summary: result.summary,
        ...(result.transcript ? { data: { transcript: result.transcript } as unknown as JsonObject } : {}),
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