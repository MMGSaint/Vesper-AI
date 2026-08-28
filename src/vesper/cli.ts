export type CliCommand =
  | { kind: "repl"; skipDiscovery: boolean }
  | { kind: "ask"; text: string; json: boolean; skipDiscovery: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "diagnostics"; skipDiscovery: boolean }
  | { kind: "status"; skipDiscovery: boolean }
  | { kind: "health"; skipDiscovery: boolean }
  | { kind: "doctor"; skipDiscovery: boolean }
  | { kind: "config-check" }
  | { kind: "export-memory" }
  | { kind: "client-hello"; skipDiscovery: boolean }
  | { kind: "first-boot-report" }
  | { kind: "unknown"; reason: string };

const COMMANDS = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--diagnostics",
  "--status",
  "--health",
  "--doctor",
  "--config-check",
  "--export-memory",
  "--client-hello",
  "--ask",
  "--first-boot-report",
]);

export function parseCli(argv: string[]): CliCommand {
  const args = argv.filter((item) => item.length > 0);
  const skipDiscovery = args.includes("--skip-discovery");
  const json = args.includes("--json");
  const flags = args.filter((item) => item !== "--skip-discovery" && item !== "--json");

  // `--ask` is the only command that takes a value, so it is matched before the
  // single-flag rule below. One question, one answer, one exit code — the shape a script
  // or another program can actually use, and the shape an end-to-end test can drive.
  const askAt = flags.indexOf("--ask");
  if (askAt !== -1) {
    const rest = flags.filter((_, index) => index !== askAt);
    const text = rest.join(" ").trim();
    if (rest.length === 0 || text.length === 0) {
      return { kind: "unknown", reason: "--ask needs something to ask: --ask \"what is happening?\"" };
    }
    return { kind: "ask", text, json, skipDiscovery };
  }

  if (json) {
    return { kind: "unknown", reason: "--json only applies to --ask." };
  }
  if (flags.length === 0) return { kind: "repl", skipDiscovery };
  if (flags.length > 1) {
    return { kind: "unknown", reason: `Unexpected extra arguments: ${flags.slice(1).join(" ")}` };
  }
  switch (flags[0]) {
    case "--help":
    case "-h":
      return { kind: "help" };
    case "--version":
    case "-V":
      return { kind: "version" };
    case "--diagnostics":
      return { kind: "diagnostics", skipDiscovery };
    case "--status":
      return { kind: "status", skipDiscovery };
    case "--health":
      return { kind: "health", skipDiscovery };
    case "--doctor":
      return { kind: "doctor", skipDiscovery };
    case "--config-check":
      return { kind: "config-check" };
    case "--export-memory":
      return { kind: "export-memory" };
    case "--client-hello":
      return { kind: "client-hello", skipDiscovery };
    case "--first-boot-report":
      return { kind: "first-boot-report" };
    default:
      return {
        kind: "unknown",
        reason: COMMANDS.has(flags[0] ?? "")
          ? "Malformed command"
          : `Unknown command: ${flags[0]}. Try --help.`,
      };
  }
}

export const CLI_HELP = `Vesper host

Usage:
  node --experimental-strip-types src/vesper/host/main.ts [command]

Commands:
  (none)            Start the interactive console (or background mode with no TTY)
  --ask "<text>"    Ask one question, print the answer, exit
  --help, -h        Show this help
  --version, -V     Print version
  --diagnostics     Print a diagnostics report and exit
  --status          Print a short runtime status and exit
  --health          Write health.json and print the path
  --doctor          Run local self-checks (no hardware claims)
  --config-check    Parse config and exit
  --export-memory   Write persistent memories to data/memory-export.json
  --client-hello    Print the companion protocol hello (no listener, no token)
  --first-boot-report
                    Run first-boot discovery to completion and print the report

Flags:
  --skip-discovery  Skip first-boot backend probes
  --json            With --ask, print the whole turn as JSON (reply, epistemic
                    tags, tool calls, pending confirmations)

Exit codes for --ask:
  0  answered
  3  an action is waiting for your confirmation; nothing was run. Answer it in
     the console. --ask never approves on your behalf.

Exit codes for --first-boot-report:
  0  report printed
  4  discovery did not complete (see logs)

In the console, type /help for conversation, memory, workspace, and system
commands. Ctrl-C stops the reply in progress; press it again to exit.

Vesper is local-first. Cloud AI is optional and never required.
`;
