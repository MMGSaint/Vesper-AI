import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VesperDirs } from "../types.ts";
import { healthFile } from "../paths.ts";

export interface ShutdownHook {
  name: string;
  run: () => Promise<void> | void;
}

export function createLifecycleController(input: {
  dirs: VesperDirs;
  hooks?: ShutdownHook[];
}) {
  let shuttingDown = false;
  const hooks = [...(input.hooks ?? [])];

  return {
    isShuttingDown: () => shuttingDown,
    addHook(hook: ShutdownHook) {
      hooks.push(hook);
    },
    async shutdown(reason = "requested") {
      if (shuttingDown) return { ok: true, summary: "Shutdown already in progress." };
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
        await mkdir(input.dirs.data, { recursive: true });
        await writeFile(
          healthFile(input.dirs),
          JSON.stringify(
            { at: new Date().toISOString(), started: false, reason, errors },
            null,
            2,
          ),
          "utf8",
        );
      } catch (error) {
        errors.push(`health: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        ok: errors.length === 0,
        summary:
          errors.length === 0
            ? `Graceful shutdown complete (${reason}).`
            : `Shutdown finished with isolated hook failures: ${errors.join("; ")}`,
      };
    },
    crashNotePath() {
      return join(input.dirs.logs, "last-crash.json");
    },
  };
}
