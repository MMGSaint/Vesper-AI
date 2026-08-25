export const PERMISSION_LEVELS = ["read", "safe", "confirm", "never"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

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

export interface VesperEvent {
  id: string;
  type: string;
  title: string;
  detail?: string;
  at: string;
  workspaceId?: string;
  severity: "info" | "warn" | "error";
  data?: JsonObject;
}

export interface VesperNotification {
  id: string;
  title: string;
  body: string;
  at: string;
  kind: "info" | "success" | "warning" | "system" | "error";
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
}

export interface CompletionResult {
  text: string;
  toolCalls: ModelToolCall[];
  providerId: string;
  model: string;
  role: ModelRole;
  unavailable?: boolean;
  error?: string;
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  args: JsonObject;
  decision: PermissionDecision;
  result?: ToolExecutionResult;
  at: string;
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
  mode: "mock" | "live" | "unavailable";
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
    | "diagnostics";
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
