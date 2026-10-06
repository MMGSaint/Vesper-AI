# Vesper per-application audio control

Vesper uses a tiny optional .NET helper backed by NAudio Windows WASAPI/Core Audio session APIs.

The helper is PID-targeted. Vesper first observes active sessions, then controls exactly that process session. It never treats an application name alone as an authority because multiple instances can exist.

Supported operations:
- list active application sessions
- read one session
- set per-application volume from 0 to 1 with read-back verification
- mute or unmute one application with read-back verification

The helper does not modify system master volume. The implementation uses NAudio per-session SimpleAudioVolume, which is the application-volume path exposed by the Windows volume mixer.

Build/publish on Windows:
dotnet publish tools/windows-audio-helper/Vesper.AudioHelper.csproj -c Release

Set VESPER_AUDIO_HELPER to the resulting Vesper.AudioHelper.exe path before starting Vesper.

This is intentionally optional. When the helper is absent, Vesper reports audio control as unavailable instead of substituting system-wide volume.
