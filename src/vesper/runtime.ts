    options.forceSimulatedWindows ?? options.dirs == null;
  const windows = createWindowsHost(hardware, {
    nativeNotifications: config.windows.nativeNotifications,
    forceSimulated: forceSimulatedWindows,
  });
  const voice = config.voice.enabled
    ? await createVoiceModule({
        enabled: true,
        stt: config.voice.stt,
        tts: config.voice.tts,
        pushToTalk: config.voice.pushToTalk,
        sttModel: config.voice.sttModel,
        ttsModel: config.voice.ttsModel,
        sttLanguage: config.voice.sttLanguage,
        sttArgs: config.voice.sttArgs,
        ttsArgs: config.voice.ttsArgs,
        audioBackend: config.voice.audioBackend,
        audioInputDevice: config.voice.audioInputDevice,
        captureSeconds: config.voice.captureSeconds,
        speakResponses: config.voice.speakResponses,
        wakeBackend: config.voice.wakePhrase.backend,
        wakeModelPath: config.voice.wakePhrase.modelPath,
        wakeThreshold: config.voice.wakePhrase.threshold,
        platform: process.platform,
      })
    : createDisabledVoice();
  const voiceSession = createVoiceSession(voice);
  const startupTarget =
    process.platform === "win32" && options.dirs?.root
      ? join(options.dirs.root, "bin", "vesper-host.cmd")
      : undefined;
  const background = createBackgroundRuntime({
    events,
    log,