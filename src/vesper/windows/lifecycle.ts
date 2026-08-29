import { mkdir, writeFile } from "node:fs/promises";
import type { VesperDirs } from "../types.ts";
import { crashNoteFile, healthFile } from "../paths.ts";

export interface ShutdownHook {
  name: string;
  run: () => Promise<void> | void;
  /**
   * Per-hook bound on how long shutdown will wait. A hook that overshoots is left
   * running and shutdown continues past it — the mission's rule is that a long
   * operation must never indefinitely block shutdown. Absent means the default (below).
   */
  timeoutMs?: number;
}

/**
 * Default per-hook budget. Chosen to be short enough that a wedged subsystem cannot
 * hold the entire process up on logoff, and long enough that ordinary flushes finish.
 * Long-running executors have their own bounded shutdown; this budget covers the
 * hook's synchronous cleanup, not the work the subsystem itself does.
 */
export const DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;

export interface ShutdownOutcome {
  ok: boolean;
  summary: string;
  errors: string[];
  reason: string;
}

export interface LifecycleController {
  isShuttingDown(): boolean;
  addHook(hook: ShutdownHook): void;
  shutdown(reason?: string): Promise<ShutdownOutcome>;
  crashNotePath(): string;
}

/**
 * Ordered, isolated shutdown.
 *
 * Every hook runs even when an earlier one throws, because a hook that fails to flush
 * memory must not also prevent the lock from being released. Failures are collected
 * and reported rather than swallowed.
 *
 * `writeHealth` is injectable so the host can record its full health payload here; the
 * built-in fallback writes the minimum that still makes the file honest.
 */
export function createLifecycleController(input: {
  dirs: VesperDirs;
  hooks?: ShutdownHook[];
  writeHealth?: (reason: string, errors: string[]) => Promise<void>;
}): LifecycleController {
  let shuttingDown = false;
  const hooks = [...(input.hooks ?? [])];

  const fallbackHealth = async (reason: string, errors: string[]) => {
    await mkdir(input.dirs.data, { recursive: true });
    await writeFile(
      healthFile(input.dirs),
      JSON.stringify(
        { at: new Date().toISOString(), pid: process.pid, started: false, reason, errors },
        null,
        2,
      ),
      "utf8",
    );
  };

  return {
    isShuttingDown: () => shuttingDown,
    addHook(hook: ShutdownHook) {
      hooks.push(hook);
    },
    async shutdown(reason = "requested"): Promise<ShutdownOutcome> {
      if (shuttingDown) {
        return { ok: true, summary: "Shutdown already in progress.", errors: [], reason };
      }
      shuttingDown = true;
      const errors: string[] = [];
      for (const hook of hooks) {
        const budget = hook.timeoutMs ?? DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS;
        try {
          // Race the hook against its own budget. The hook keeps running past the
          // timeout — we cannot cancel a Promise it did not co-operate to make
          // cancellable — but shutdown moves on. Recording the timeout as an error
          // makes the outcome honest: the hook did NOT finish cleanly.
          // Wait for whichever comes first — the hook resolving, or the budget timer
          // firing — using ONE Promise instance whose resolver is called by both. The
          // simple `Promise.race([hookRun, timerP])` shape produces two chained
          // promises that Node's runtime keeps bookkeeping on after the race returns;
          // node:test then flags the whole test as pending and cancels the suite.
          // Owning the resolver ourselves lets the timer settle both sides at once.
          let hookError: unknown = undefined;
          let timedOutFlag = false;
          const settled = new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve();
            };
            const t = setTimeout(() => {
              timedOutFlag = true;
              finish();
            }, budget);
            // Deliberately NOT unref'd. If we unref it, and the hook itself has no
            // referenced work, Node's loop drains before the budget fires — meaning
            // the process could exit while shutdown was still waiting for the timer
            // it planted. The budget is the whole point of a bounded shutdown; it
            // must hold the loop until it has ruled.
            void Promise.resolve()
              .then(() => hook.run())
              .then(
                () => {
                  clearTimeout(t);
                  finish();
                },
                (error) => {
                  hookError = error;
                  clearTimeout(t);
                  finish();
                },
              );
          });
          await settled;
          if (timedOutFlag) {
            errors.push(`${hook.name}: exceeded ${budget}ms shutdown budget`);
          } else if (hookError !== undefined) {
            errors.push(`${hook.name}: ${hookError instanceof Error ? hookError.message : String(hookError)}`);
          }
        } catch (error) {
          // Only reachable for a synchronous throw the racer setup itself produces.
          errors.push(`${hook.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        await (input.writeHealth ?? fallbackHealth)(reason, errors);
      } catch (error) {
        errors.push(`health: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        ok: errors.length === 0,
        errors,
        reason,
        summary:
          errors.length === 0
            ? `Graceful shutdown complete (${reason}).`
            : `Shutdown finished with isolated hook failures: ${errors.join("; ")}`,
      };
    },
    crashNotePath() {
      return crashNoteFile(input.dirs);
    },
  };
}
