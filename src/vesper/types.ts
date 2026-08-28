export const PERMISSION_LEVELS = ["read", "safe", "confirm", "never"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/**
 * Memory scope: which layer a fact belongs to.
 *
 * Scope decides two things that must never be confused - who can see a fact, and
 * whether it leaves the device. The distinction matters most for `device`: "my desktop
 * has a 7900 XT" is true of one machine, and syncing it as a user fact would make Vesper
 * believe it of the laptop too.
 *
 *   session   - this conversation only. Never persisted, never synced.
 *   device    - this machine. Persisted; syncs, but always carries its deviceId and is
 *               never reinterpreted as a user fact.
 *   workspace - tied to a workspace (Gaming, Development, Mortis...). Persisted; syncs.
 *   user      - follows the user across every device. Persisted; syncs.
 *   global    - assistant/system knowledge not tied to the user. Persisted; syncs.
 */
export const MEMORY_SCOPES = ["session", "device", "workspace", "user", "global"] as const;
export type MemoryScopeLevel = (typeof MEMORY_SCOPES)[number];

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "project",
  "workflow",
  "routine",
  "task",
  "config",
  "context",
  "session",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MODEL_ROLES = [
  "fast",
  "everyday",
  "reasoning",
  "coding",
  "large",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const EPISTEMIC_TAGS = [
  "checked",
  "think",
  "recommend",
  "requested",
  "changed",
  "could_not_access",
] as const;
export type EpistemicTag = (typeof EPISTEMIC_TAGS)[number];

export const HARDWARE_MODES = ["live", "simulated", "unavailable"] as const;
export type HardwareMode = (typeof HARDWARE_MODES)[number];

export const FEATURE_STATUSES = [
  "implemented_tested",
  "implemented_hardware_dependent",
  "mocked_simulated",
  "documented_not_implemented",
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const BACKGROUND_STATES = [
  "stopped",
  "starting",
  "running",
  "paused",
  "stopping",
  "degraded",
] as const;
export type BackgroundState = (typeof BACKGROUND_STATES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolSpec {
  name: string;
  description: string;
  permission: PermissionLevel;
  parameters: ToolParameterSchema;
  workspaces?: string[];
  specialist?: string;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "array" | "object";
      description?: string;
      enum?: string[];
    }
  >;
  required?: string[];
}

export interface ToolHandlerContext {
  workspaceId: string;
  dryRun?: boolean;
}

export type ToolHandler = (
  args: JsonObject,
  context: ToolHandlerContext,
) => Promise<ToolExecutionResult> | ToolExecutionResult;

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  data?: JsonValue;
  epistemic: EpistemicTag;
  changed?: boolean;
}

export interface PermissionDecision {
  allowed: boolean;
  level: PermissionLevel;
  reason: string;
  requiresConfirmation: boolean;
  toolName: string;
}

export interface PendingConfirmation {
  id: string;
  toolName: string;
  args: JsonObject;
  reason: string;
  createdAt: string;
  workspaceId: string;
  /**
   * Who asked for the action being held. Recorded so an approval can never grant more
   * authority than the request carried, and so the audit trail says which device set a
   * dangerous action up. Deliberately minimal: an id, not a cached capability manifest,
   * because authority must be re-read live at approval time rather than replayed.
   */
  requestedBy?: { kind: "local" | "remote"; deviceId?: string };
}

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  source: "user" | "system" | "seed" | "agent";
  tags?: string[];
  provenance?: { origin: string; kind: "stated" | "observed" | "inferred" };
  /** Which layer this fact belongs to. Decides visibility and whether it syncs. */
  scope: MemoryScopeLevel;
  /**
   * The device a `device`-scoped fact describes. A device fact that loses this would
   * become indistinguishable from a fact about the user, which is exactly the
   * misattribution scope exists to prevent.
   */
  deviceId?: string;
  /** Monotonic per-entry revision. Sync uses it to order writes deterministically. */
  revision: number;
  /** The device that last wrote this entry, for conflict attribution. */
  originDevice?: string;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  roots: string[];
  include?: string[];
  exclude?: string[];
  workspaceIds?: string[];
  enabled: boolean;
}

export interface KnowledgeHit {
  sourceId: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
  provenance?: { sourceId: string; path: string; offset: number };
}

export interface WorkspaceDefinition {
  id: string;
  name: string;
  description: string;
  tools?: string[];
  knowledgeSourceIds?: string[];
  memoryNamespace?: string;
  defaultModelRole?: ModelRole;
}

/**
 * The event bus carries these. New optional fields (correlationId, provenance,
 * retention) are additive: every existing emit site still compiles unchanged, and every
 * hydrator that filters on `{id, at, type}` still accepts old rows.
 *
 * Retention:
 *   - "transient" — never journaled; useful only inside the 500-entry hot ring
 *   - "durable"   — journaled to disk with retention per the EventJournal policy
 *   - "summary"   — reserved for future rolled-up snapshots produced by summarizers
 *   - undefined   — the journal derives the answer from event type (see event-journal.ts)
 *
 * Provenance says who authored the event, which is not the same as which subsystem
 * happens to be emitting on their behalf. Matches the shape VesperNotification already
 * uses so a downstream reader has one mental model.
 */
export interface VesperEvent {
  id: string;
  type: string;
  title: string;
  detail?: string;
  at: string;
  workspaceId?: string;
  severity: "info" | "warn" | "error";
  data?: JsonObject;
  /** Groups related events across a single turn / session / task. */
  correlationId?: string;
  /** Who authored this event, in the same vocabulary as VesperNotification. */
  provenance?: {
    author: "subsystem" | "model" | "user" | "remote";
    source?: string;
    deviceId?: string;
  };
  /** Journal-behaviour hint. Absent → derived from `type` at journaling time. */
  retention?: "transient" | "durable" | "summary";
}

export interface VesperNotification {
  id: string;
  title: string;
  body: string;
  at: string;
  kind: "info" | "success" | "warning" | "system" | "error";
  /**
   * Who wrote it. Set by the hub from the caller, never from the payload.
   *
   * A hub entry written by the model through the `notify` tool used to be byte-for-byte
   * indistinguishable from one emitted by `app_launch` or by a subsystem. The hub keeps
   * a hundred entries, every turn carries the most recent five, and the console prints
   * each under the reply — so a model that had just been refused could write a durable,
   * replayed, Vesper-voiced assertion that the action had succeeded, sitting next to the
   * refusal that is the true record.
   *
   * `subsystem` is Vesper's own machinery saying something happened. `model` is the
   * assistant repeating a claim, which the reader is entitled to weigh differently.
   */
  author: "subsystem" | "model";
  cooldownKey?: string;
}

export interface CpuSnapshot {
  name: string;
  cores: number;
  threads: number;
  utilizationPct: number;
  tempC: number | null;
  clocksMhz?: number | null;
}

export interface GpuSnapshot {
  name: string;
  vramGB: number;
  utilizationPct: number;
  tempC: number | null;
  vramUsedGB: number;
  clocksMhz?: number | null;
  powerW?: number | null;
}

export interface RamSnapshot {
  totalGB: number;
  usedGB: number;
}

export interface HardwareSnapshot {
  mode: HardwareMode;
  os: string;
  hostname?: string;
  cpu: CpuSnapshot;
  gpu: GpuSnapshot | null;
  ram: RamSnapshot;
  notes: string[];
  capturedAt: string;
}

export interface CapabilityProfile {
  generatedAt: string;
  currentMachine: {
    os: string;
    arch: string;
    cpuModel?: string;
    ramGB?: number;
    hostname?: string;
  };
  targetProfile: {
    cpu: string;
    gpu: string;
    vramGB: number;
    ramGB: number;
    os: string;
  };
  backends: BackendAvailability[];
  models: DiscoveredModel[];
  telemetry: FeatureStatus;
  audio: FeatureStatus;
  windowsIntegration: FeatureStatus;
  optimizer: FeatureStatus;
  voice: FeatureStatus;
  notes: string[];
}

export interface BackendAvailability {
  id: "ollama" | "llamacpp" | "llamacpp-vulkan" | "llamacpp-rocm" | "xai-optional" | "cpu-offload";
  available: boolean;
  endpoint?: string;
  detail: string;
  status: FeatureStatus;
}

export interface DiscoveredModel {
  provider: string;
  name: string;
  roleHint?: ModelRole;
  available: boolean;
  /**
   * Optional metadata reported by the backend. Every field stays `null` when the
   * backend did not report it - Vesper does not guess a model's size or context.
   */
  family?: string | null;
  parameterSizeB?: number | null;
  quantization?: string | null;
  sizeGB?: number | null;
  contextLength?: number | null;
}

export interface ModelProviderInfo {
  id: string;
  kind: "local" | "optional-cloud" | "test";
  available: boolean;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  role: ModelRole;
  temperature?: number;
  maxTokens?: number;
  /** Caller-owned cancellation. Providers must abort in-flight work when this fires. */
  signal?: AbortSignal;
  /**
   * When supplied, providers that can stream call this with each text delta as it
   * arrives. Providers that cannot stream call it exactly once with the full text so
   * callers can use one code path. Never called after the completion resolves.
   */
  onDelta?: (delta: string) => void;
}

/**
 * Token counts as *reported by the provider*. Vesper never estimates tokens from
 * character counts and never presents an estimate as a measurement: a field that the
 * backend did not report stays `null`.
 */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Provider-reported generation time, when the backend exposes it. */
  evalDurationMs: number | null;
  /** Provider-reported model load time, when the backend exposes it. */
  loadDurationMs: number | null;
}

export interface CompletionTiming {
  /**
   * Time to first token. Only set when the response was genuinely streamed and a first
   * delta was observed. `null` for non-streamed responses, where TTFT is unmeasurable.
   */
  ttftMs: number | null;
  /** Wall-clock time for the whole completion, measured locally. */
  totalMs: number;
}

export interface CompletionResult {
  text: string;
  toolCalls: ModelToolCall[];
  providerId: string;
  model: string;
  role: ModelRole;
  unavailable?: boolean;
  error?: string;
  /** True only when the transport actually delivered incremental deltas. */
  streamed?: boolean;
  /** Present only when the provider reported counters. */
  usage?: TokenUsage;
  timing?: CompletionTiming;
  finishReason?: string;
  /** True when the completion stopped because the caller's signal aborted. */
  aborted?: boolean;
}

export function emptyUsage(): TokenUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    evalDurationMs: null,
    loadDurationMs: null,
  };
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  args: JsonObject;
  decision: PermissionDecision;
  result?: ToolExecutionResult;
  at: string;
  /**
   * The confirmation this call queued, when it queued one.
   *
   * Without it the agent had to re-find "the confirmation I just created" by searching
   * the queue for a matching tool *name*, so any older unresolved confirmation for the
   * same tool shadowed the new one — and the consent prompt described one action while
   * approving a different one. A confirmation should only ever be reachable by the id of
   * the call that produced it.
   */
  confirmationId?: string;
}

export interface AgentTurn {
  id: string;
  userText: string;
  reply: string;
  epistemic: EpistemicTag[];
  toolCalls: ToolCallRecord[];
  pendingConfirmations: PendingConfirmation[];
  workspaceId: string;
  model?: {
    providerId: string;
    model: string;
    role: ModelRole;
    unavailable?: boolean;
  };
  notifications: VesperNotification[];
  events: VesperEvent[];
  at: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  title?: string;
  cpuPct?: number;
  memoryMB?: number;
  approved?: boolean;
}

export interface ApprovedApp {
  id: string;
  name: string;
  executable: string;
  aliases: string[];
  workspaces?: string[];
}

export interface OptimizerStatus {
  available: boolean;
  /**
   * Which adapter Vesper is actually using. Set by Vesper, never by the endpoint.
   *
   * This is the LIVE / SIMULATED / MOCKED distinction the product promises, so it is a
   * fact about Vesper, not a fact the optimizer is entitled to assert. See `parseStatus`.
   */
  mode: "mock" | "live" | "unavailable";
  /**
   * What the endpoint said about itself, if anything. Recorded so a disagreement with
   * `mode` can be shown; read by nothing that decides how Vesper describes itself.
   */
  reportedMode?: "mock" | "live" | "unavailable" | null;
  currentProfile: string | null;
  lastAction: string | null;
  lastResult: string | null;
  performanceState: string | null;
  detail: string;
}

export interface OptimizerTelemetry {
  available: boolean;
  hardware: HardwareSnapshot;
  bound: "cpu" | "gpu" | "io" | "idle" | "unknown";
  notes: string[];
}

export interface OptimizerHealth {
  reachable: boolean;
  latencyMs: number | null;
  lastError: string | null;
  mode: OptimizerStatus["mode"];
}

export interface AuditEntry {
  id: string;
  at: string;
  category:
    | "model"
    | "tool"
    | "permission"
    | "optimizer"
    | "event"
    | "error"
    | "lifecycle"
    | "memory"
    | "windows"
    | "voice"
    | "health"
    | "diagnostics"
    | "rollback"
    | "autonomy";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: JsonObject;
}

export interface WorkloadContext {
  vrchatRunning: boolean;
  obsRunning: boolean;
  obsRecording: boolean | "unknown";
  obsStreaming: boolean | "unknown";
  gameRunning: boolean;
  games: string[];
  optimizerActive: boolean;
  notes: string[];
  conclusions?: { statement: string; kind: "observed" | "inferred"; evidence: string }[];
}

export interface BackgroundHealth {
  state: BackgroundState;
  startedAt: string | null;
  paused: boolean;
  startOnLogin: boolean;
}

export interface TrayMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  role: "open" | "status" | "diagnostics" | "pause" | "resume" | "startup" | "exit" | "separator";
}

export interface FirstBootStep {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  status: FeatureStatus;
}

export interface FirstBootReport {
  startedAt: string;
  finishedAt: string;
  steps: FirstBootStep[];
  profile: CapabilityProfile;
  defaults: {
    hardwareMode: string;
    optimizerMode: string;
    voiceEnabled: boolean;
    preferredBackend: string | null;
  };
  reportText: string;
  persisted: boolean;
  benchmark?: {
    ran: boolean;
    refused: boolean;
    reason: string;
  };
}

export interface DiagnosticReport {
  generatedAt: string;
  runtime: { instanceId: string; started: boolean; health: BackgroundState };
  models: { active: string; available: { id: string; kind: string; available: boolean }[] };
  memory: { persistent: number; session: number };
  tools: { count: number };
  permissions: { neverAllowAutonomous: string[] };
  optimizer: OptimizerStatus;
  windows: {
    platform: string;
    simulated: boolean;
    trayAvailable: boolean;
    notificationsAvailable: boolean;
    startOnLogin: boolean;
  };
  voice: { enabled: boolean; stt: string; tts: string; available: boolean };
  knowledge: {
    sources: number;
    /** The embedding provider in use, and the one the index was actually built with. */
    embeddingProvider: string;
    indexedWith: string | null;
    detail: string;
  };
  context: WorkloadContext;
  capability: CapabilityProfile | null;
  recentErrors: { at: string; message: string }[];
  classification: Record<string, FeatureStatus>;
  reportText: string;
}

export interface VesperDirs {
  root: string;
  config: string;
  data: string;
  logs: string;
  models: string;
}
