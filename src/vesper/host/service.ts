import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime, type RuntimeOptions, type VesperRuntime } from "../runtime.ts";
import { FileStorage } from "../storage.ts";
import { createLogger } from "../logging.ts";
import { createJsonlSink } from "../audit-file.ts";
import { loadHostConfig, writeConfigIfMissing } from "../config-file.ts";
import {
  auditLogFile,
  configFile,
  firstBootReportFile,
  healthFile,
  lastErrorFile,
  resolveVesperDirs,
  stateFile,
} from "../paths.ts";
import { runDoctor, formatDoctor, type DoctorReport } from "../doctor.ts";
import type { VesperDirs } from "../types.ts";
import { VESPER_VERSION } from "../version.ts";
import { createClientGateway, type VesperClientGateway } from "../client/gateway.ts";

export interface ProductionHost {
  runtime: VesperRuntime;
  gateway: VesperClientGateway;
  dirs: VesperDirs;
  configSource: "file" | "default";
  writeHealth(): Promise<string>;
  writeLastError(): Promise<void>;
  exportMemory(): Promise<string>;
  doctor(): Promise<DoctorReport>;
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

  const loaded = await loadHostConfig(configFile(dirs));
  await writeConfigIfMissing(configFile(dirs), loaded.config);
  const log =
    options?.runtime?.logger ??
    createLogger({
      sink: createJsonlSink(auditLogFile(dirs)),
    });
  if (!loaded.ok) {
    log.warn("lifecycle", "Host config invalid; using defaults", {
      errors: loaded.errors.join("; "),
    });
  }
  const storage = options?.runtime?.storage ?? new FileStorage(stateFile(dirs));
  const runtime = await createRuntime({
    ...options?.runtime,
    config: options?.runtime?.config ?? loaded.config,
    storage,
    logger: log,
  });
  await runtime.start();
  const gateway = createClientGateway(runtime);
  const host: ProductionHost = {
    runtime,
    gateway,
    dirs,
    configSource: loaded.source,
    async writeHealth() {
      const diagnostics = await runtime.diagnostics();
      const payload = {
        at: new Date().toISOString(),
        version: VESPER_VERSION,
        instanceId: runtime.instanceId,
        started: runtime.started,
        health: runtime.background.health(),
        models: runtime.models.status(),
        optimizer: diagnostics.optimizer.available,
        pendingConfirmations: runtime.confirmations.size,
        client: {
          protocol: gateway.hello().protocol,
          version: gateway.hello().version,
          transport: "in-process",
          remoteOs: "UNAVAILABLE",
        },
      };
      const path = healthFile(dirs);
      await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
      if (runtime.firstBootReport) {
        await writeFile(firstBootReportFile(dirs), runtime.firstBootReport.reportText, "utf8");
      }
      return path;
    },
    async writeLastError() {
      const error = await runtime.lastError();
      if (!error) return;
      await writeFile(lastErrorFile(dirs), JSON.stringify(error, null, 2), "utf8");
    },
    async exportMemory() {
      const entries = await runtime.memory.exportPersistent();
      const path = join(dirs.data, "memory-export.json");
      await writeFile(
        path,
        `${JSON.stringify({ exportedAt: new Date().toISOString(), count: entries.length, memories: entries }, null, 2)}\n`,
        "utf8",
      );
      return path;
    },
    async doctor() {
      const error = await runtime.lastError();
      return runDoctor({
        dirs,
        config: runtime.config,
        configOk: loaded.ok,
        configErrors: loaded.errors,
        storageReadable: true,
        lastError: error?.message ?? null,
      });
    },
    async shutdown() {
      await runtime.stop();
      await host.writeLastError();
      await writeFile(
        healthFile(dirs),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            version: VESPER_VERSION,
            started: false,
            health: runtime.background.health(),
          },
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

export { formatDoctor };
