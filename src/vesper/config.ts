import { z } from "zod";
import type { ModelRole, PermissionLevel } from "./types.ts";

const permissionLevel = z.enum(["read", "safe", "confirm", "never"]);
const modelRole = z.enum(["fast", "everyday", "reasoning", "coding", "large"]);

const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  tools: z.array(z.string()).optional(),
  knowledgeSourceIds: z.array(z.string()).optional(),
  memoryNamespace: z.string().optional(),
  defaultModelRole: modelRole.optional(),
});

const modelTargetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const vesperConfigSchema = z.object({
  identity: z.object({
    name: z.string().default("Vesper"),
    userName: z.string().default("User"),
  }),
  dataDir: z.string().default("data/vesper"),
  hardware: z
    .object({
      mode: z.enum(["auto", "simulated", "live"]).default("auto"),
      target: z
        .object({
          cpu: z.string().default("AMD Ryzen 9 9950X"),
          gpu: z.string().default("AMD Radeon RX 7900 XT"),
          vramGB: z.number().default(20),
          ramGB: z.number().default(96),
          os: z.string().default("Windows"),
        })
        .default({
          cpu: "AMD Ryzen 9 9950X",
          gpu: "AMD Radeon RX 7900 XT",
          vramGB: 20,
          ramGB: 96,
          os: "Windows",
        }),
    })
    .default({
      mode: "auto",
      target: {
        cpu: "AMD Ryzen 9 9950X",
        gpu: "AMD Radeon RX 7900 XT",
        vramGB: 20,
        ramGB: 96,
        os: "Windows",
      },
    }),
  models: z
    .object({
      allowOptionalCloud: z.boolean().default(false),
      roles: z.record(z.string(), modelTargetSchema).default({
        fast: { provider: "ollama", model: "qwen2.5:3b" },
        everyday: { provider: "ollama", model: "qwen2.5:14b" },
        reasoning: { provider: "ollama", model: "qwen2.5:32b" },
        coding: { provider: "ollama", model: "qwen2.5-coder:14b" },
        large: { provider: "llamacpp", model: "qwen2.5-32b-q4" },
      }),
      fallback: z.array(z.string()).default(["echo"]),
      endpoints: z
        .object({
          ollama: z.string().default("http://127.0.0.1:11434/v1"),
          llamacpp: z.string().default("http://127.0.0.1:8088/v1"),
          xai: z.string().default("https://api.x.ai/v1"),
        })
        .default({
          ollama: "http://127.0.0.1:11434/v1",
          llamacpp: "http://127.0.0.1:8088/v1",
          xai: "https://api.x.ai/v1",
        }),
    })
    .default({
      allowOptionalCloud: false,
      roles: {
        fast: { provider: "ollama", model: "qwen2.5:3b" },
        everyday: { provider: "ollama", model: "qwen2.5:14b" },
        reasoning: { provider: "ollama", model: "qwen2.5:32b" },
        coding: { provider: "ollama", model: "qwen2.5-coder:14b" },
        large: { provider: "llamacpp", model: "qwen2.5-32b-q4" },
      },
      fallback: ["echo"],
      endpoints: {
        ollama: "http://127.0.0.1:11434/v1",
        llamacpp: "http://127.0.0.1:8088/v1",
        xai: "https://api.x.ai/v1",
      },
    }),
  workspaces: z.array(workspaceSchema).default([]),
  defaultWorkspaceId: z.string().default("general"),
  knowledgeSources: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        roots: z.array(z.string()),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        workspaceIds: z.array(z.string()).optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  approvedApps: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        executable: z.string(),
        aliases: z.array(z.string()).default([]),
        workspaces: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  approvedRoots: z.array(z.string()).default([]),
  embeddings: z
    .object({
      /**
       * Local embedding model used for knowledge retrieval. When the backend is not
       * running, retrieval degrades to lexical scoring rather than failing.
       */
      model: z.string().default("nomic-embed-text"),
      provider: z.string().default("ollama"),
      enabled: z.boolean().default(true),
    })
    .default({ model: "nomic-embed-text", provider: "ollama", enabled: true }),
  permissions: z
    .object({
      toolOverrides: z.record(z.string(), permissionLevel).default({}),
      neverAllowAutonomous: z.array(z.string()).default([
        "disk_wipe",
        "credential_extract",
        "disable_security",
        "privileged_hardware",
      ]),
    })
    .default({
      toolOverrides: {},
      neverAllowAutonomous: [
        "disk_wipe",
        "credential_extract",
        "disable_security",
        "privileged_hardware",
      ],
    }),
  optimizer: z
    .object({
      mode: z.enum(["mock", "live", "off"]).default("mock"),
      endpoint: z.string().nullable().default(null),
      timeoutMs: z.number().default(2500),
      retries: z.number().default(1),
    })
    .default({ mode: "mock", endpoint: null, timeoutMs: 2500, retries: 1 }),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      stt: z.string().default("faster-whisper"),
      tts: z.string().default("piper"),
      pushToTalk: z.boolean().default(false),
      /** Whisper model name or CTranslate2 model directory. */
      sttModel: z.string().default("base"),
      /** Piper voice, normally a path to a .onnx file. */
      ttsModel: z.string().default("en_US-lessac-medium"),
      sttLanguage: z.string().optional(),
      /** Extra arguments appended verbatim, for a local build with a different CLI. */
      sttArgs: z.array(z.string()).default([]),
      ttsArgs: z.array(z.string()).default([]),
    })
    .default({
      enabled: false,
      stt: "faster-whisper",
      tts: "piper",
      pushToTalk: false,
      sttModel: "base",
      ttsModel: "en_US-lessac-medium",
      sttArgs: [],
      ttsArgs: [],
    }),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      cooldownMs: z.number().default(60_000),
    })
    .default({ enabled: true, cooldownMs: 60_000 }),
  windows: z
    .object({
      enableTray: z.boolean().default(true),
      startOnLogin: z.boolean().default(false),
      nativeNotifications: z.boolean().default(true),
    })
    .default({ enableTray: true, startOnLogin: false, nativeNotifications: true }),
  agent: z
    .object({
      maxToolIterations: z.number().default(8),
      idleEventDriven: z.boolean().default(true),
      idleIntervalMs: z.number().default(30_000),
    })
    .default({ maxToolIterations: 8, idleEventDriven: true, idleIntervalMs: 30_000 }),
});

export type VesperConfig = z.infer<typeof vesperConfigSchema>;

export const DEFAULT_WORKSPACES = [
  {
    id: "general",
    name: "General",
    description: "Everyday assistance, memory, and system awareness.",
    defaultModelRole: "everyday" as ModelRole,
  },
  {
    id: "gaming",
    name: "Gaming",
    description: "Game launch, performance context, and session awareness.",
    defaultModelRole: "fast" as ModelRole,
  },
  {
    id: "vrchat",
    name: "VRChat",
    description: "VRChat-ready workflows and social/session context.",
    defaultModelRole: "fast" as ModelRole,
  },
  {
    id: "streaming",
    name: "Streaming",
    description: "OBS, capture, and streaming session coordination.",
    defaultModelRole: "everyday" as ModelRole,
  },
  {
    id: "development",
    name: "Development",
    description: "Coding, research, and local project work.",
    defaultModelRole: "coding" as ModelRole,
  },
  {
    id: "mortis",
    name: "Mortis",
    description:
      "Approved Mortis project context only. Mortis remains a separate codebase and canon.",
    defaultModelRole: "everyday" as ModelRole,
    knowledgeSourceIds: ["mortis-approved"],
  },
];

export const DEFAULT_APPS = [
  { id: "discord", name: "Discord", executable: "Discord.exe", aliases: ["discord"] },
  { id: "obs", name: "OBS Studio", executable: "obs64.exe", aliases: ["obs", "obs studio"] },
  { id: "steam", name: "Steam", executable: "steam.exe", aliases: ["steam"] },
  {
    id: "wwm",
    name: "Where Winds Meet",
    executable: "WhereWindsMeet.exe",
    aliases: ["where winds meet", "wwm"],
    workspaces: ["gaming"],
  },
  {
    id: "vrchat",
    name: "VRChat",
    executable: "VRChat.exe",
    aliases: ["vrchat", "vrc"],
    workspaces: ["vrchat"],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    executable: "Code.exe",
    aliases: ["vscode", "code", "vs code"],
    workspaces: ["development"],
  },
  { id: "chrome", name: "Google Chrome", executable: "chrome.exe", aliases: ["chrome", "browser"] },
];

export function defaultConfig(overrides?: Record<string, unknown>): VesperConfig {
  return vesperConfigSchema.parse({
    identity: { name: "Vesper", userName: "User" },
    workspaces: DEFAULT_WORKSPACES,
    approvedApps: DEFAULT_APPS,
    approvedRoots: ["notes", "docs", "knowledge"],
    embeddings: { model: "nomic-embed-text", provider: "ollama", enabled: true },
    knowledgeSources: [
      {
        id: "vesper-docs",
        name: "Vesper documentation",
        roots: ["docs"],
        enabled: true,
      },
      {
        id: "mortis-approved",
        name: "Approved Mortis notes (local, curated)",
        roots: ["knowledge/mortis"],
        workspaceIds: ["mortis"],
        enabled: true,
      },
    ],
    ...overrides,
  });
}

export function parseConfig(input: unknown): {
  config: VesperConfig;
  ok: boolean;
  errors: string[];
} {
  const result = vesperConfigSchema.safeParse(input);
  if (result.success) return { config: result.data, ok: true, errors: [] };
  return {
    config: defaultConfig(),
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

export function stricterPermission(
  declared: PermissionLevel,
  override?: PermissionLevel,
): PermissionLevel {
  const rank: Record<PermissionLevel, number> = {
    read: 0,
    safe: 1,
    confirm: 2,
    never: 3,
  };
  if (!override) return declared;
  return rank[override] > rank[declared] ? override : declared;
}
