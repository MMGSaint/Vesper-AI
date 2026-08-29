import { createInterface } from "node:readline/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { loadHostConfig, patchConfigFile } from "../config-file.ts";
import {
  formatStartupSnapshot,
  reconcileStartupRegistration,
  snapshotStartupRegistration,
} from "../windows/startup-manage.ts";
import { configFile, crashNoteFile, healthFile, instanceLockFile, resolveVesperDirs } from "../paths.ts";
import { inspectInstanceLock } from "./instance-lock.ts";
import { readHealthStatus } from "./health.ts";
import { formatCrashNote, writeCrashNoteSync } from "./crash.ts";

/** Kept referenced while the daemon runs; it is the only thing holding the event loop. */
const KEEP_ALIVE_MS = 60_000;

/**
 * Wait until everything written to stdout and stderr has actually reached the OS.
 *
 * `stream.write()` returning false means the data is buffered; the drain event says it
 * has been handed over. On Linux a pipe write completes synchronously so this resolves
 * immediately, which is why the missing flush was invisible in local runs and in the
 * ubuntu CI job while the windows job failed on every commit for a month.
 */
async function flushStdio(): Promise<void> {
  const settle = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
      // `writableNeedDrain` asks whether anything is still buffered WITHOUT appending
      // to the stream. Probing with `write("")` would queue a chunk of its own, which
      // on a backpressured stream is one more thing to wait for.
      if (!stream.writableNeedDrain) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stream.off("drain", finish);
        resolve();
      };
      stream.once("drain", finish);
      // Never hang a shutdown on a stream that will not drain (a closed pipe, a
      // consumer that went away). Deliberately NOT unref'd: an unref'd timer cannot
      // keep the loop alive, so on a stuck stream the promise would never settle, the
      // loop would drain, and Node would exit 0 on its own — losing the exit code this
      // shutdown was called with. `--ask` documents exit 3 for a pending confirmation,
      // and a wrong exit code is worse than a bounded 2s wait.
      setTimeout(finish, 2000);
    });
  await Promise.all([settle(process.stdout), settle(process.stderr)]);
}

/**
 * Handle the three startup-registration CLI commands.
 *
 * Deliberately does NOT construct a runtime: the whole point is that a user with a
 * broken runtime can still fix their startup registration, and running Vesper twice to
 * repair its Run key would be a footgun. Reads the config file directly and touches
 * only the Run key and the config file.
 *
 * Exit codes are the same shape as the reconcile result:
 *   0 in-sync   — the intent already matches the registry (or Linux+off)
 *   1 changed   — a write happened (`enable-startup` wrote, `disable-startup` removed)
 *   2 refused/unable — nothing was written because it would have been unsafe or we
 *                     could not look at the registry to decide
 */
async function handleStartupCommand(
  kind: "startup-status" | "enable-startup" | "disable-startup",
  dirs: ReturnType<typeof resolveVesperDirs>,
): Promise<number> {
  const loaded = await loadHostConfig(configFile(dirs));
  if (!loaded.ok) {
    console.error(`Config invalid:\n${loaded.errors.join("\n")}`);
    return 2;
  }
  const launcher = resolveLauncherPath(dirs);

  if (kind === "startup-status") {
    const intent = {
      enabled: loaded.config.windows.startOnLogin,
      launcher,
    };
    const snapshot = await snapshotStartupRegistration({ intent });
    console.log(formatStartupSnapshot(snapshot));
    return snapshot.inSync ? 0 : 2;
  }

  const enabled = kind === "enable-startup";

  // Reconcile FIRST, patch config second. The reverse order let `--enable-startup` on
  // Linux flip the persisted preference to `true` before refusing to touch the
  // registry, which reads as either lying to the user or setting up a future
  // reconcile-on-boot they never asked for. If we cannot make the registry match, the
  // preference does not move either.
  const result = await reconcileStartupRegistration({
    intent: { enabled, launcher },
  });
  console.log(result.detail);
  if (result.outcome !== "in-sync" && result.outcome !== "changed") {
    return 2;
  }

  const patched = await patchConfigFile(configFile(dirs), {
    windows: { startOnLogin: enabled },
  });
  if (!patched.ok) {
    console.error(`Could not update ${configFile(dirs)}: ${patched.reason}`);
    return 2;
  }
  return result.outcome === "in-sync" ? 0 : 1;
}

/**
 * Where the persistent launcher lives, or null when Vesper does not know.
 *
 * The runtime is `--experimental-strip-types src/vesper/host/main.ts` and cannot be
 * pointed at from a Run key directly. The packaged `bin/vesper-host.cmd` (or the
 * generated one at %LOCALAPPDATA%\Vesper\bin\vesper-host.cmd) is the actual
 * launcher. This function returns the packaged one if it can find the install root, and
 * null otherwise — a null result means `--enable-startup` refuses rather than plants a
 * launcher path Vesper cannot honour.
 */
function resolveLauncherPath(dirs: ReturnType<typeof resolveVesperDirs>): string | null {
  const env = process.env.VESPER_LAUNCHER;
  if (env && env.length > 0) return env;
  // The installer writes vesper-host.cmd under <install-root>/bin. `dirs.root` is that
  // install root when running from an installed layout; on a source checkout it points
  // at the repository root, where packaging/windows/vesper-host.cmd is shipped.
  if (dirs.root) {
    return join(dirs.root, "bin", "vesper-host.cmd");
  }
  return null;
}

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

  // Startup registration commands are deliberately handled BEFORE createProductionHost:
  // they touch only the Run key and the config file, they must not require a runtime
  // (the whole point is that a user with a broken runtime can still fix their
  // registration), and they must not acquire the instance lock (repairing startup while
  // Vesper is running should be possible from a second terminal). Three-way exit code:
  // 0 in-sync, 1 changed, 2 refused/unable.
  if (
    command.kind === "startup-status" ||
    command.kind === "enable-startup" ||
    command.kind === "disable-startup"
  ) {
    const exit = await handleStartupCommand(command.kind, dirs);
    await flushStdio();
    process.exit(exit);
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
      : command.kind === "first-boot-report"
        ? false
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
    // Flush stdout/stderr BEFORE exiting.
    //
    // Node's stream-to-pipe writes are synchronous on Linux and macOS but
    // ASYNCHRONOUS on Windows (documented under "process I/O"). Every one-shot
    // command here writes its answer with console.log and then calls this helper,
    // so on Windows `process.exit()` was terminating the process while the write
    // was still queued — and the output was simply lost. Not a test artifact: any
    // Windows user piping `vesper --ask "..."` into a file or another program got
    // an empty result and a zero exit code, on the one OS Vesper targets.
    await flushStdio();
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
  if (command.kind === "ask") {
    const turn = await runtime.chat(command.text);

    // A pending confirmation is reported, never answered here.
    //
    // `--ask` is one question from a script, and a script cannot be the person the
    // confirmation is asking. Auto-approving would make a convenience flag into a way to
    // run confirm-tier tools unattended, which is the "confirmation is not authorization"
    // rule read backwards. The exit code says a human is needed; the action stays queued
    // for the console.
    const waiting = turn.pendingConfirmations;

    if (command.json) {
      console.log(
        JSON.stringify(
          {
            reply: turn.reply,
            epistemic: turn.epistemic,
            workspaceId: turn.workspaceId,
            toolCalls: turn.toolCalls.map((call) => ({
              tool: call.toolName,
              allowed: call.decision.allowed,
              level: call.decision.level,
              requiresConfirmation: call.decision.requiresConfirmation,
              ok: call.result?.ok ?? null,
              epistemic: call.result?.epistemic ?? null,
              summary: call.result?.summary ?? null,
            })),
            pendingConfirmations: waiting.map((pending) => ({
              id: pending.id,
              tool: pending.toolName,
              reason: pending.reason,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(turn.reply);
      for (const pending of waiting) {
        console.error(`Waiting for your confirmation: ${pending.toolName} — ${pending.reason}`);
      }
    }

    await shutdown(waiting.length > 0 ? 3 : 0, "ask");
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

  if (command.kind === "first-boot-report") {
    // The report is produced by the background discovery pass that starts on
    // `runtime.start()`. Waiting on it here is what turns "the discovery happened, and
    // its result is written to a file somewhere" into "the discovery result is on your
    // terminal, now." Exit 0 when the report exists, exit 4 when discovery failed and
    // left the report null, per the pattern for one-shot commands with two outcomes.
    const report = await runtime.waitForFirstBoot();
    if (report) {
      console.log(report.reportText);
      await shutdown(0, "first-boot-report");
    } else {
      console.error("First-boot discovery did not produce a report (see logs).");
      await shutdown(4, "first-boot-report-failed");
    }
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

/**
 * Run main() only when this module IS the program, not when it is imported.
 *
 * The previous check compared `process.argv[1]` against a POSIX-shaped suffix:
 * `entry.endsWith("host/main.ts")`. On Windows argv[1] is
 * `D:\a\Vesper-AI\src\vesper\host\main.ts` — backslashes — so the suffix never
 * matched, `main()` never ran, and the process exited 0 having printed nothing.
 * Every child-process test in ask.test.ts saw `exit=0 stdout="" stderr=""` and the
 * windows-latest CI job failed on every commit of this branch for a month, while
 * ubuntu-latest stayed green because the forward-slash form matched there.
 *
 * That is also the real user-facing bug: `vesper --ask "..."` on Windows — the one
 * OS Vesper targets — did nothing at all and reported success.
 *
 * Compare resolved paths instead of string suffixes. `fileURLToPath` and `resolve`
 * both yield the platform's native separators, so the two sides are directly
 * comparable on Windows and POSIX alike. The basename check keeps the packaged
 * `vesper-host.mjs` entry point working.
 */
const entryArg = process.argv[1];
if (entryArg) {
  const thisFile = fileURLToPath(import.meta.url);
  const invoked = resolve(entryArg);
  // Windows filesystems are case-insensitive, so a launcher that spells the path
  // with different casing is still this file.
  const sameFile =
    invoked === thisFile ||
    (process.platform === "win32" && invoked.toLowerCase() === thisFile.toLowerCase());
  if (sameFile || basename(invoked) === "vesper-host.mjs") {
    void main();
  }
}
