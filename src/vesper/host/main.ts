import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createProductionHost,
  formatDoctor,
  InstanceAlreadyRunningError,
  type ProductionHost,
} from "./service.ts";
import { CLI_HELP, parseCli } from "../cli.ts";
import { runConsole } from "./console.ts";
import { VESPER_NAME, VESPER_VERSION } from "../version.ts";
import { loadHostConfig } from "../config-file.ts";
import { configFile, crashNoteFile, healthFile, instanceLockFile, resolveVesperDirs } from "../paths.ts";
import { inspectInstanceLock } from "./instance-lock.ts";
import { readHealthStatus } from "./health.ts";
import { formatCrashNote, writeCrashNoteSync } from "./crash.ts";

/** Kept referenced while the daemon runs; it is the only thing holding the event loop. */
const KEEP_ALIVE_MS = 60_000;

async function main() {
  const command = parseCli(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(CLI_HELP);
    return;
  }
  if (command.kind === "version") {
    console.log(`${VESPER_NAME} ${VESPER_VERSION}`);
    return;
  }
  if (command.kind === "unknown") {
    console.error(command.reason);
    process.exitCode = 1;
    return;
  }

  const production = process.env.VESPER_ENV === "production";
  const dirs = resolveVesperDirs({ production });

  if (command.kind === "config-check") {
    const loaded = await loadHostConfig(configFile(dirs));
    if (!loaded.ok) {
      console.error(`Config invalid:\n${loaded.errors.join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Config OK (${loaded.source}) at ${loaded.path}`);
    return;
  }

  // Status must work *while* a host is running, so it reads the health file rather
  // than booting a second runtime over the first one's state.
  if (command.kind === "status") {
    const held = await inspectInstanceLock(instanceLockFile(dirs));
    if (held.live) {
      const health = await readHealthStatus(healthFile(dirs));
      console.log(
        JSON.stringify(
          {
            version: VESPER_VERSION,
            source: "health-file",
            lockedBy: held.record,
            liveness: health.state,
            summary: health.summary,
            heartbeatAt: health.heartbeatAt,
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  const skipDiscovery =
    command.kind === "export-memory"
      ? true
      : "skipDiscovery" in command
        ? command.skipDiscovery
        : process.env.VESPER_SKIP_DISCOVERY === "1";

  let host: ProductionHost;
  try {
    host = await createProductionHost({
      production,
      lock: true,
      runtime: { skipDiscovery },
    });
  } catch (error) {
    if (error instanceof InstanceAlreadyRunningError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const runtime = host.runtime;

  if (host.crashNote) {
    console.error(formatCrashNote(host.crashNote));
  }

  let shuttingDown = false;
  const shutdown = async (code = 0, reason = "requested") => {
    if (shuttingDown) return;
    shuttingDown = true;
    await host.shutdown(reason);
    process.exit(code);
  };
  const sigintShutdown = () => void shutdown(0, "SIGINT");
  const sigtermShutdown = () => void shutdown(0, "SIGTERM");
  process.on("SIGINT", sigintShutdown);
  process.on("SIGTERM", sigtermShutdown);

  if (command.kind === "diagnostics") {
    const report = await runtime.diagnostics();
    console.log(report.reportText);
    await shutdown(0, "diagnostics");
    return;
  }
  if (command.kind === "status") {
    const health = runtime.background.health();
    console.log(
      JSON.stringify(
        {
          version: VESPER_VERSION,
          source: "live",
          instanceId: runtime.instanceId,
          pid: process.pid,
          state: health.state,
          started: runtime.started,
          workspace: runtime.workspaces.current().id,
          pendingConfirmations: runtime.confirmations.size,
          models: runtime.models.status(),
        },
        null,
        2,
      ),
    );
    await shutdown(0, "status");
    return;
  }
  if (command.kind === "health") {
    const path = await host.writeHealth();
    console.log(path);
    await shutdown(0, "health");
    return;
  }
  if (command.kind === "doctor") {
    const report = await host.doctor();
    console.log(formatDoctor(report));
    await shutdown(report.ok ? 0 : 1, "doctor");
    return;
  }
  if (command.kind === "export-memory") {
    const path = await host.exportMemory();
    console.log(path);
    await shutdown(0, "export-memory");
    return;
  }
  if (command.kind === "client-hello") {
    console.log(
      JSON.stringify(
        {
          ...host.gateway.hello(),
          transport: "in-process",
          forbidden: host.gateway.forbiddenPowers(),
          note: "No network listener. Tokens are issued by the host, not by this command.",
        },
        null,
        2,
      ),
    );
    await shutdown(0, "client-hello");
    return;
  }

  if (!input.isTTY) {
    await runBackground(host, shutdown);
    return;
  }

  const rl = createInterface({ input, output });
  let sigintHandler: (() => boolean) | null = null;
  const onSigint = () => {
    // Ctrl-C cancels the reply in progress; it only stops Vesper when nothing is running.
    if (sigintHandler?.()) return;
    void shutdown(0, "SIGINT");
  };
  process.off("SIGINT", sigintShutdown);
  process.on("SIGINT", onSigint);

  try {
    await runConsole({
      io: {
        readLine: async (prompt: string) => {
          try {
            return await rl.question(prompt);
          } catch {
            // The interface closed (Ctrl-D, or shutdown while waiting for input).
            return null;
          }
        },
        write: (text: string) => output.write(text),
        writeLine: (text: string) => output.write(`${text}\n`),
      },
      runtime,
      doctor: async () => formatDoctor(await host.doctor()),
      onInterrupt: (handler) => {
        sigintHandler = handler;
        return () => {
          sigintHandler = null;
        };
      },
    });
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
    if (!shuttingDown) {
      shuttingDown = true;
      await host.shutdown("console-exit");
    }
  }
}

/**
 * Background mode: no console, no prompt, and — unlike before — the process actually
 * stays up. Nothing else references the event loop (the scheduler and heartbeat timers
 * are deliberately unref'd), so the anchor below is what keeps Vesper alive until a
 * signal arrives.
 */
async function runBackground(host: ProductionHost, shutdown: (code?: number, reason?: string) => Promise<void>) {
  const dirs = host.dirs;
  const anchor = setInterval(() => {}, KEEP_ALIVE_MS);

  const onFatal = (source: "uncaught-exception" | "unhandled-rejection") => (error: unknown) => {
    // Written synchronously: the process is going down and there is no turn left to
    // await in. The next start reads this and reports it.
    writeCrashNoteSync(crashNoteFile(dirs), {
      at: new Date().toISOString(),
      source,
      pid: process.pid,
      reason: error instanceof Error ? error.message : String(error),
      detail: error instanceof Error ? error.stack?.slice(0, 4000) : undefined,
    });
    console.error(`Vesper is exiting after an ${source}: ${error instanceof Error ? error.message : String(error)}`);
    clearInterval(anchor);
    process.exit(1);
  };
  process.on("uncaughtException", onFatal("uncaught-exception"));
  process.on("unhandledRejection", onFatal("unhandled-rejection"));
  // Windows console close; harmless to register elsewhere.
  process.on("SIGHUP", () => void shutdown(0, "SIGHUP"));

  console.log(
    `${VESPER_NAME} host ${VESPER_VERSION} running in background mode (pid ${process.pid}, instance ${host.runtime.instanceId}). Send SIGTERM or SIGINT to stop.`,
  );
  if (host.crashNote) {
    await host.notify("Vesper recovered", host.crashNote.reason);
  }

  host.lifecycle.addHook({ name: "keep-alive", run: () => clearInterval(anchor) });
  // main() returns here; the anchor keeps the event loop alive until a signal fires.
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("host/main.ts") || entry.endsWith("host/main.js") || entry.endsWith("vesper-host.mjs")) {
  void main();
}
