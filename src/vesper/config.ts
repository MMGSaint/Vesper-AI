      home: null,
      tokenPath: null,
      timeoutMs: 2500,
      retries: 1,
      allowRemoteEndpoint: false,
    }),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      stt: z.string().default("faster-whisper"),
      tts: z.string().default("piper"),
      pushToTalk: z.boolean().default(false),
      audioBackend: z.enum(["ffmpeg", "none"]).default("ffmpeg"),
      /** Exact Windows DirectShow microphone name. Empty means first discovered device. */
      audioInputDevice: z.string().max(256).optional(),
      /** Seconds captured for a push-to-talk command. */
      captureSeconds: z.number().min(1).max(30).default(6),
      /** Speak model replies after voice commands. */
      speakResponses: z.boolean().default(true),
      wakePhrase: z.object({
        /** Off by default: enabling continuously samples the selected microphone. */
        enabled: z.boolean().default(false),
        phrase: z.string().min(1).max(64).default("hey vesper"),
        detectionSeconds: z.number().min(1).max(6).default(2),
        commandSeconds: z.number().min(1).max(30).default(8),
        cooldownMs: z.number().min(250).max(60_000).default(1500),
      }).default({
        enabled: false,
        phrase: "hey vesper",
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
    }),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      cooldownMs: z.number().default(60_000),
    })
    .default({ enabled: true, cooldownMs: 60_000 }),
  windows: z
    .object({
      enableTray: z.boolean().default(true),
      startOnLogin: z.boolean().default(false),