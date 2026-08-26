import { mkdir, writeFile } from "node:fs/promises";
import type { VesperDirs } from "../types.ts";
import { crashNoteFile, healthFile } from "../paths.ts";

export interface ShutdownHook {
  name: string;
  run: () => Promise<void> | void;
}

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
        try {
          await hook.run();
        } catch (error) {
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
