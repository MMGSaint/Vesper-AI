using System.Text.Json;
using NAudio.CoreAudioApi;

namespace Vesper.AudioHelper;

internal static class Program
{
    private sealed record Request(string Command, int? Pid = null, float? Volume = null, bool? Muted = null);
    private sealed record SessionInfo(int Pid, string ProcessName, string DisplayName, float Volume, bool Muted, string SessionIdentifier);

    private static int Main()
    {
        try
        {
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                Request? request;
                try { request = JsonSerializer.Deserialize<Request>(line); }
                catch (JsonException ex) { WriteError("Invalid request JSON: " + ex.Message); continue; }

                if (request is null || string.IsNullOrWhiteSpace(request.Command))
                { WriteError("Request command is required."); continue; }

                try
                {
                    object result = request.Command switch
                    {
                        "list-sessions" => ListSessions(),
                        "get-session" => GetSession(RequirePid(request)),
                        "set-volume" => SetVolume(RequirePid(request), RequireVolume(request)),
                        "set-mute" => SetMute(RequirePid(request), request.Muted ?? throw new ArgumentException("muted is required")),
                        _ => throw new ArgumentException("Unknown command: " + request.Command),
                    };
                    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, result }));
                }
                catch (Exception ex) { WriteError(ex.Message); }
                Console.Out.Flush();
            }
            return 0;
        }
        catch (Exception ex) { WriteError(ex.Message); return 1; }
    }

    private static SessionInfo[] ListSessions()
    {
        using var enumerator = new MMDeviceEnumerator();
        using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        var result = new List<SessionInfo>();

        foreach (var session in device.AudioSessionManager.Sessions)
        {
            int pid;
            try { pid = checked((int)session.GetProcessID); } catch { continue; }
            if (pid <= 0) continue;

            var volume = session.SimpleAudioVolume;
            string processName;
            try { processName = System.Diagnostics.Process.GetProcessById(pid).ProcessName; }
            catch { processName = "pid-" + pid; }

            result.Add(new SessionInfo(
                pid, processName, session.DisplayName ?? string.Empty,
                volume.Volume, volume.Mute, session.GetSessionIdentifier));
        }

        return result
            .OrderBy(x => x.ProcessName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.Pid)
            .ToArray();
    }

    private static SessionInfo GetSession(int pid) =>
        ListSessions().FirstOrDefault(x => x.Pid == pid)
        ?? throw new InvalidOperationException("No active audio session found for PID " + pid + ".");

    private static object SetVolume(int pid, float requested)
    {
        if (requested is < 0f or > 1f) throw new ArgumentOutOfRangeException(nameof(requested), "volume must be between 0 and 1");
        return WithSession(pid, session =>
        {
            var previous = session.SimpleAudioVolume.Volume;
            session.SimpleAudioVolume.Volume = requested;
            var observed = session.SimpleAudioVolume.Volume;
            if (Math.Abs(observed - requested) > 0.005f)
                throw new InvalidOperationException("Windows did not verify the requested volume.");

            return new
            {
                pid,
                previousVolume = previous,
                volume = observed,
                muted = session.SimpleAudioVolume.Mute,
                processName = ProcessName(pid),
            };
        });
    }

    private static object SetMute(int pid, bool muted) =>
        WithSession(pid, session =>
        {
            var previous = session.SimpleAudioVolume.Mute;
            session.SimpleAudioVolume.Mute = muted;
            var observed = session.SimpleAudioVolume.Mute;
            if (observed != muted) throw new InvalidOperationException("Windows did not verify the requested mute state.");

            return new
            {
                pid,
                previousMuted = previous,
                muted = observed,
                volume = session.SimpleAudioVolume.Volume,
                processName = ProcessName(pid),
            };
        });

    private static T WithSession<T>(int pid, Func<AudioSessionControl, T> action)
    {
        using var enumerator = new MMDeviceEnumerator();
        using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        var session = device.AudioSessionManager.Sessions.FirstOrDefault(s => SafePid(s) == pid)
            ?? throw new InvalidOperationException("No active audio session found for PID " + pid + ".");
        return action(session);
    }

    private static int SafePid(AudioSessionControl session)
    {
        try { return checked((int)session.GetProcessID); } catch { return -1; }
    }

    private static string ProcessName(int pid)
    {
        try { return System.Diagnostics.Process.GetProcessById(pid).ProcessName; }
        catch { return "pid-" + pid; }
    }

    private static int RequirePid(Request request) =>
        request.Pid is > 0 and <= int.MaxValue
            ? request.Pid.Value
            : throw new ArgumentException("pid must be a positive integer");

    private static float RequireVolume(Request request) =>
        request.Volume is >= 0f and <= 1f
            ? request.Volume.Value
            : throw new ArgumentException("volume must be between 0 and 1");

    private static void WriteError(string message)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = message }));
        Console.Out.Flush();
    }
}
