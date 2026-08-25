export { createRuntime, VesperRuntime, type RuntimeOptions } from "./runtime.ts";
export { defaultConfig, parseConfig, vesperConfigSchema, type VesperConfig } from "./config.ts";
export { createLogger, redactObject } from "./logging.ts";
export { MemoryStorage, FileStorage } from "./storage.ts";
export { evaluatePermission, PermissionDeniedError } from "./permissions.ts";
export { classifyIntent } from "./agent.ts";
export { resolveRole } from "./models/router.ts";
export { createScriptedProvider } from "./models/scripted.ts";
export { createEchoProvider } from "./models/echo.ts";
export { createBenchmarkHarness, emptyBenchmarkReport } from "./models/benchmark.ts";
export { createMockOptimizer, createHttpOptimizerAdapter } from "./specialists/optimizer.ts";
export { inspectWorkload, explainPerformance } from "./specialists/context.ts";
export { detectObs, detectVrchat, groundedConclusions, readyPlan } from "./specialists/gaming.ts";
export { VESPER_SYSTEM_PROMPT } from "./personality.ts";
export { buildDiagnostics, formatDiagnostics } from "./diagnostics.ts";
export { runFirstBootAutomation, firstBoot, conservativeModelPlan } from "./bootstrap.ts";
export { createBackgroundRuntime, createTrayMenu, invokeTrayAction } from "./windows/runtime.ts";
export { describeInstallPlan, describeUninstallPlan, describeResetPlan } from "./windows/packaging.ts";
export { createIdleScheduler } from "./scheduler.ts";
export { createHashEmbeddings } from "./knowledge/embeddings.ts";
export { chunkText } from "./knowledge/chunk.ts";
export { resolveVesperDirs, configFile, auditLogFile, lastErrorFile } from "./paths.ts";
export { createProductionHost } from "./host/service.ts";
export { parseCli } from "./cli.ts";
export { loadHostConfig, writeConfigIfMissing } from "./config-file.ts";
export { runDoctor, formatDoctor } from "./doctor.ts";
export { VESPER_VERSION } from "./version.ts";
export {
  CLIENT_PROTOCOL_ID,
  CLIENT_PROTOCOL_VERSION,
  DEFAULT_COMPANION_SCOPES,
  FORBIDDEN_REMOTE_POWERS,
  isClientError,
} from "./client/protocol.ts";
export { ClientSessionStore } from "./client/session.ts";
export { VesperClientGateway, createClientGateway } from "./client/gateway.ts";
export type * from "./types.ts";
