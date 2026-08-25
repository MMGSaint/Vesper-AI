import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime, type RuntimeOptions, type VesperRuntime } from "../runtime.ts";
import { FileStorage } from "../storage.ts";
import { firstBootReportFile, healthFile, resolveVesperDirs, stateFile } from "../paths.ts";
import type { VesperDirs } from "../types.ts";

export interface ProductionHost {
  runtime: VesperRuntime;
  dirs: VesperDirs;
  writeHealth(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createProductionHost(options?: {
  runtime?: RuntimeOptions;
  production?: boolean;
  dirs?: VesperDirs;
}): Promise<ProductionHost> {
  const dirs = options?.dirs ?? resolveVesperDirs({ production: options?.production });
  await mkdir(dirs.data, { recursive: true });
  await mkdir(dirs.logs, { recursive: true });
  await mkdir(dirs.config, { recursive: true });
  const storage = options?.runtime?.storage ?? new FileStorage(stateFile(dirs));
  const runtime = await createRuntime({
    ...options?.runtime,
    storage,
  });
  await runtime.start();
  const host: ProductionHost = {
    runtime,
    dirs,
    async writeHealth() {
      const diagnostics = await runtime.diagnostics();
      const payload = {
        at: new Date().toISOString(),
        instanceId: runtime.instanceId,
        started: runtime.started,
        health: runtime.background.health(),
        models: runtime.models.status(),
        optimizer: diagnostics.optimizer.available,
      };
      await writeFile(healthFile(dirs), JSON.stringify(payload, null, 2), "utf8");
      if (runtime.firstBootReport) {
        await writeFile(firstBootReportFile(dirs), runtime.firstBootReport.reportText, "utf8");
      }
    },
    async shutdown() {
      await runtime.stop();
      await writeFile(
        join(dirs.data, "health.json"),
        JSON.stringify(
          { at: new Date().toISOString(), started: false, health: runtime.background.health() },
          null,
          2,
        ),
        "utf8",
      );
    },
  };
  await host.writeHealth();
  return host;
}
