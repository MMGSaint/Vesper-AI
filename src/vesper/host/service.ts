import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime, type RuntimeOptions, type VesperRuntime } from "../runtime.ts";
import { FileStorage } from "../storage.ts";
import { createLogger } from "../logging.ts";
import { loadHostConfig, writeConfigIfMissing } from "../config-file.ts";
import {
  auditLogFile,
  configFile,
  crashNoteFile,
  firstBootReportFile,
  healthFile,
  instanceLockFile,
  lastErrorFile,
  resolveVesperDirs,
  stateFile,
} from "../paths.ts";
import { runDoctor, formatDoctor, type DoctorReport } from "../doctor.ts";
import type { VesperDirs } from "../types.ts";
import { VESPER_VERSION } from "../version.ts";
import { createClientGateway, type VesperClientGateway } from "../client/gateway.ts";
import { createLifecycleController, type LifecycleController } from "../windows/lifecycle.ts";
import { createHostNotificationAdapter, type HostNotificationAdapter } from "../windows/notifications.ts";
import {
  acquireInstanceLock,
  type InstanceLock,
  type LockRecord,
} from "./instance-lock.ts";
import { HEARTBEAT_INTERVAL_MS, readHealthStatus, type HealthLiveness } from "./health.ts";
import {
  clearCrashNote,
  detectUncleanExit,
  readCrashNote,
  writeCrashNote,
  type CrashNote,
} from "./crash.ts";
import { createRotatingAuditSink, type RotatingAuditSink } from "./audit-rotation.ts";

/** Thrown instead of starting a second host over a live one's state. */
export class InstanceAlreadyRunningError extends Error {
  readonly holder: LockRecord | null;
  readonly lockPath: string;
  constructor(message: string, holder: LockRecord | null, lockPath: string) {
    super(message);
    this.name = "InstanceAlreadyRunningError";
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

export interface ProductionHost {
  runtime: VesperRuntime;
  gateway: VesperClientGateway;
  dirs: VesperDirs;
  configSource: "file" | "default";
  lock: InstanceLock | null;
  lifecycle: LifecycleController;
  notifications: HostNotificationAdapter;
  /** Set when the previous run ended without going through shutdown. */
  crashNote: CrashNote | null;
  /** What the health file said about the previous run, before this one overwrote it. */
  previousHealth: HealthLiveness;
  writeHealth(): Promise<string>;
  heartbeat(): Promise<void>;
  writeLastError(): Promise<void>;
  exportMemory(): Promise<string>;
  doctor(): Promise<DoctorReport>;
  notify(title: string, body: string): Promise<{ ok: boolean; summary: string }>;
  shutdown(reason?: string): Promise<void>;
}

export async function createProductionHost(options?: {
  runtime?: RuntimeOptions;
  production?: boolean;
  dirs?: VesperDirs;
  /**
   * Take the cross-process instance lock. The process entry point sets this; library
   * embedders and tests that deliberately run several hosts against separate data
   * directories leave it off.
   */
  lock?: boolean;
  /** Overrides the pid recorded in the lock and health files. Tests only. */
  pid?: number;
}): Promise<ProductionHost> {
  const dirs = options?.dirs ?? resolveVesperDirs({ production: options?.production });
  const pid = options?.pid ?? process.pid;
  await mkdir(dirs.data, { recursive: true });
  await mkdir(dirs.logs, { recursive: true });
  await mkdir(dirs.config, { recursive: true });

  // Read the outgoing health file before anything overwrites it: it is the only
  // evidence that the previous run died rather than exited.
  const previousHealth = await readHealthStatus(healthFile(dirs));

  let lock: InstanceLock | null = null;
  let staleLock: LockRecord | null = null;
  if (options?.lock) {
    const acquired = await acquireInstanceLock({ path: instanceLockFile(dirs), pid });
    if (!acquired.ok) {
      throw new InstanceAlreadyRunningError(acquired.reason, acquired.holder, instanceLockFile(dirs));
    }
    lock = acquired.lock;
    staleLock = acquired.stale;
  }

  const loaded = await loadHostConfig(configFile(dirs));
  await writeConfigIfMissing(configFile(dirs), loaded.config);

  let audit: RotatingAuditSink | null = null;
  const log =
    options?.runtime?.logger ??
    (() => {
      audit = createRotatingAuditSink({ path: auditLogFile(dirs) });
      return createLogger({ sink: audit.sink });
    })();
  if (!loaded.ok) {
    log.warn("lifecycle", "Host config invalid; using defaults", {
      errors: loaded.errors.join("; "),
    });
  }

  // A note written on the way down by a live crash beats one inferred here.
  const liveNote = await readCrashNote(crashNoteFile(dirs));
  const crashNote = liveNote ?? detectUncleanExit({ health: previousHealth, staleLock });
  if (crashNote && !liveNote) {
    await writeCrashNote(crashNoteFile(dirs), crashNote);
  }

  const storage = options?.runtime?.storage ?? new FileStorage(stateFile(dirs));
  const runtime = await createRuntime({
    ...options?.runtime,
    config: options?.runtime?.config ?? loaded.config,
    storage,
    logger: log,
  });
  await runtime.start();

  if (crashNote) {
    log.warn("lifecycle", "Previous Vesper run ended unexpectedly", {
      source: crashNote.source,
      pid: crashNote.pid ?? "unknown",
      reason: crashNote.reason,
    });
    runtime.events.emit({
      type: "lifecycle.crash_recovered",
      title: "Recovered from an unexpected shutdown",
      detail: crashNote.reason,
      severity: "warn",
    });
    // Reported once: the next start is clean unless it crashes again.
    await clearCrashNote(crashNoteFile(dirs));
  }

  const notifications = createHostNotificationAdapter({
    enabled: runtime.config.notifications.enabled && runtime.config.windows.nativeNotifications,
  });

  const gateway = createClientGateway(runtime);
  let heartbeatAt = new Date().toISOString();

  const healthPayload = (started: boolean, reason?: string) => ({
    at: new Date().toISOString(),
    version: VESPER_VERSION,
    instanceId: runtime.instanceId,
    pid,
    started,
    heartbeatAt,
    lockPath: lock?.path ?? null,
    reason: reason ?? null,
    health: runtime.background.health(),
    models: runtime.models.status(),
    pendingConfirmations: runtime.confirmations.size,
    client: {
      protocol: gateway.hello().protocol,
      version: gateway.hello().version,
      transport: "in-process",
      remoteOs: "UNAVAILABLE",
    },
  });

  const lifecycle = createLifecycleController({
    dirs,
    writeHealth: async (reason, errors) => {
      await mkdir(dirs.data, { recursive: true });
      heartbeatAt = new Date().toISOString();
      await writeFile(
        healthFile(dirs),
        JSON.stringify({ ...healthPayload(false, reason), shutdownErrors: errors }, null, 2),
        "utf8",
      );
    },
  });

  const host: ProductionHost = {
    runtime,
    gateway,
    dirs,
    configSource: loaded.source,
    lock,
    lifecycle,
    notifications,
    crashNote,
    previousHealth,
    async writeHealth() {
      const diagnostics = await runtime.diagnostics();
      heartbeatAt = new Date().toISOString();
      const path = healthFile(dirs);
      await writeFile(
        path,
        JSON.stringify({ ...healthPayload(runtime.started), optimizer: diagnostics.optimizer.available }, null, 2),
        "utf8",
      );
      if (runtime.firstBootReport) {
        await writeFile(firstBootReportFile(dirs), runtime.firstBootReport.reportText, "utf8");
      }
      return path;
    },
    async heartbeat() {
      heartbeatAt = new Date().toISOString();
      await writeFile(healthFile(dirs), JSON.stringify(healthPayload(runtime.started), null, 2), "utf8");
      await lock?.heartbeat();
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
    notify(title, body) {
      return notifications.notify(title, body);
    },
    async shutdown(reason = "requested") {
      await lifecycle.shutdown(reason);
    },
  };

  lifecycle.addHook({ name: "runtime", run: () => runtime.stop() });
  lifecycle.addHook({ name: "last-error", run: () => host.writeLastError() });
  lifecycle.addHook({ name: "heartbeat", run: () => clearInterval(beat) });
  lifecycle.addHook({ name: "audit-rotation", run: () => audit?.stop() });
  lifecycle.addHook({ name: "instance-lock", run: async () => lock?.release() });

  // Unreferenced on purpose: the heartbeat records liveness, it is not what keeps a
  // background host alive. `main.ts` owns that anchor.
  const beat = setInterval(() => void host.heartbeat(), HEARTBEAT_INTERVAL_MS);
  beat.unref?.();

  await host.writeHealth();
  return host;
}

export { formatDoctor };
