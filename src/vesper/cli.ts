export type CliCommand =
  | { kind: "repl"; skipDiscovery: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "diagnostics"; skipDiscovery: boolean }
  | { kind: "status"; skipDiscovery: boolean }
  | { kind: "health"; skipDiscovery: boolean }
  | { kind: "doctor"; skipDiscovery: boolean }
  | { kind: "config-check" }
  | { kind: "export-memory" }
  | { kind: "client-hello"; skipDiscovery: boolean }
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
]);

export function parseCli(argv: string[]): CliCommand {
  const args = argv.filter((item) => item.length > 0);
  const skipDiscovery = args.includes("--skip-discovery");
  const flags = args.filter((item) => item !== "--skip-discovery");
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
  --help, -h        Show this help
  --version, -V     Print version
  --diagnostics     Print a diagnostics report and exit
  --status          Print a short runtime status and exit
  --health          Write health.json and print the path
  --doctor          Run local self-checks (no hardware claims)
  --config-check    Parse config and exit
  --export-memory   Write persistent memories to data/memory-export.json
  --client-hello    Print the companion protocol hello (no listener, no token)

Flags:
  --skip-discovery  Skip first-boot backend probes

In the console, type /help for conversation, memory, workspace, and system
commands. Ctrl-C stops the reply in progress; press it again to exit.

Vesper is local-first. Cloud AI is optional and never required.
`;
