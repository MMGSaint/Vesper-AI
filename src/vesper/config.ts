      /** Seconds captured for a push-to-talk command. */
      captureSeconds: z.number().min(1).max(30).default(6),
      /** Speak model replies after voice commands. */
      speakResponses: z.boolean().default(true),
      wakePhrase: z.object({
        /** Off by default: enabling continuously samples the selected microphone. */
        enabled: z.boolean().default(false),
        backend: z.enum(["stt", "openwakeword"]).default("stt"),
        phrase: z.string().min(1).max(64).default("hey vesper"),
        /** Required when backend=openwakeword. Vesper never downloads a model automatically. */
        modelPath: z.string().max(1024).optional(),
        threshold: z.number().min(0.05).max(0.99).default(0.5),
        detectionSeconds: z.number().min(1).max(6).default(2),
        commandSeconds: z.number().min(1).max(30).default(8),
        cooldownMs: z.number().min(250).max(60_000).default(1500),
      }).superRefine((wake, ctx) => {
        if (wake.backend === "openwakeword" && !wake.modelPath) {
          ctx.addIssue({
            code: "custom",
            path: ["modelPath"],
            message: "wakePhrase.modelPath is required when wakePhrase.backend is openwakeword.",
          });
        }
        if (wake.modelPath && /[\0\r\n]/.test(wake.modelPath)) {
          ctx.addIssue({
            code: "custom",
            path: ["modelPath"],
            message: "wakePhrase.modelPath contains unsupported control characters.",
          });
        }
      }).default({
        enabled: false,
        backend: "stt",
        phrase: "hey vesper",
        threshold: 0.5,
        detectionSeconds: 2,
        commandSeconds: 8,
        cooldownMs: 1500,
      }),
      /** Whisper model name or CTranslate2 model directory. */
      sttModel: z.string().default("base"),
      /** Piper voice, normally a path to a .onnx file. */
      ttsModel: z.string().default("en_US-lessac-medium"),
      sttLanguage: z.string().optional(),
      /** Extra arguments appended verbatim for a local build with a different CLI. */
      sttArgs: z.array(z.string()).default([]),
      ttsArgs: z.array(z.string()).default([]),
    })
    .default({
      enabled: false,
      stt: "faster-whisper",
      tts: "piper",
      pushToTalk: false,
      audioBackend: "ffmpeg",
      captureSeconds: 6,
      speakResponses: true,
      wakePhrase: {
        enabled: false,
        phrase: "hey vesper",
        detectionSeconds: 2,
        commandSeconds: 8,
        cooldownMs: 1500,
      },
      sttModel: "base",
      ttsModel: "en_US-lessac-medium",
      sttArgs: [],
      ttsArgs: [],