import { z } from "zod";
import type { ModelRole, PermissionLevel } from "./types.ts";
import { checkCloudEndpoint, checkLocalEndpoint } from "./net.ts";

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
      /**
       * Explicit opt-in for pointing a *local* provider at a non-private host - an
       * inference box reached over a VPN, say. Off by default: without this an endpoint
       * declared local must stay on this machine or this LAN, so `allowOptionalCloud:
       * false` cannot be quietly defeated by rewriting a URL.
       */
      allowRemoteEndpoints: z.boolean().default(false),
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
    .superRefine((models, ctx) => {
      // `ollama` and `llamacpp` are declared local by the router; an endpoint is the only
      // thing that decides where their traffic - and any prompt in it - actually goes.
      for (const name of ["ollama", "llamacpp"] as const) {
        const check = checkLocalEndpoint(models.endpoints[name], {
          allowRemote: models.allowRemoteEndpoints,
          label: `models.endpoints.${name}`,
        });
        if (!check.ok) {
          ctx.addIssue({ code: "custom", path: ["endpoints", name], message: check.reason });
        }
      }
      const cloud = checkCloudEndpoint(models.endpoints.xai, "models.endpoints.xai");
      if (!cloud.ok) {
        ctx.addIssue({ code: "custom", path: ["endpoints", "xai"], message: cloud.reason });
      }
    })
    .default({
      allowOptionalCloud: false,
      allowRemoteEndpoints: false,
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
  obs: z
    .object({
      /** Off by default: connecting to OBS is the user's choice, not an assumption. */
      enabled: z.boolean().default(false),
      url: z.string().default("ws://127.0.0.1:4455"),
      /** obs-websocket password. Never logged, never exported. */
      password: z.string().optional(),
      timeoutMs: z.number().default(3000),
    })
    .default({ enabled: false, url: "ws://127.0.0.1:4455", timeoutMs: 3000 }),
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
      /**
       * Nothing runs without asking.
       *
       * Set only by Vesper itself, when the configuration file could not be read at all
       * and nothing is known about what the user authorised. `toolOverrides` cannot
       * express "everything is stricter" — it names tools one at a time — so an
       * unreadable file would otherwise lose a user's `fs_read: "never"` and leave the
       * tool autonomous at its declared level. Under this flag every autonomous level
       * becomes a confirmation instead, which is the honest answer to "I do not know
       * what you allowed".
       */
      lockedDown: z.boolean().default(false),
      toolOverrides: z.record(z.string(), permissionLevel).default({}),
      neverAllowAutonomous: z.array(z.string()).default([
        "disk_wipe",
        "credential_extract",
        "disable_security",
        "privileged_hardware",
      ]),
    })
    .default({
      lockedDown: false,
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
      /** Explicit opt-in for an optimizer that is not on this machine or this LAN. */
      allowRemoteEndpoint: z.boolean().default(false),
    })
    .superRefine((optimizer, ctx) => {
      // Validated whenever an endpoint is set, not only in live mode: a stored endpoint
      // becomes live the moment someone flips `mode`, and it should never have been
      // accepted in the first place.
      if (optimizer.endpoint === null) return;
      const check = checkLocalEndpoint(optimizer.endpoint, {
        allowRemote: optimizer.allowRemoteEndpoint,
        label: "optimizer.endpoint",
      });
      if (!check.ok) ctx.addIssue({ code: "custom", path: ["endpoint"], message: check.reason });
    })
    .default({ mode: "mock", endpoint: null, timeoutMs: 2500, retries: 1, allowRemoteEndpoint: false }),
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
      wakeWord: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
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
      wakeWord: { enabled: false },
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
  /**
   * Independently enabled computer-context sources.
   *
   * Process listing for game/OBS workload still happens through the existing
   * `context_status` / inspectWorkload path. These flags only control the ContextEngine
   * seam. Invasive sources stay off: enabling them in config does not start capture
   * until a source is actually implemented, and a disabled source does no I/O.
   */
  context: z
    .object({
      sources: z
        .object({
          process: z.boolean().default(false),
          window: z.boolean().default(false),
          clipboard: z.boolean().default(false),
          filesystem: z.boolean().default(false),
          browser: z.boolean().default(false),
          screen: z.boolean().default(false),
          audio: z.boolean().default(false),
        })
        .default({
          process: false,
          window: false,
          clipboard: false,
          filesystem: false,
          browser: false,
          screen: false,
          audio: false,
        }),
    })
    .default({
      sources: {
        process: false,
        window: false,
        clipboard: false,
        filesystem: false,
        browser: false,
        screen: false,
        audio: false,
      },
    }),
  agent: z
    .object({
      maxToolIterations: z.number().default(8),
      idleEventDriven: z.boolean().default(true),
      idleIntervalMs: z.number().default(30_000),
      /** How many day-partitions the durable event journal keeps. */
      journalRetentionDays: z.number().int().min(1).max(365).default(14),
      /** Cap on events per day-partition — a floody subsystem cannot grow unbounded. */
      journalMaxPerDay: z.number().int().min(50).max(50_000).default(1000),
      /**
       * Whether the idle-scheduler tick drives the task queue. Off by default so a
       * fresh install does not start reminders or delayed tool_calls before the owner
       * has completed first boot. Executors (noop, reminder, tool_call) are registered
       * either way; this flag is the on-switch, not the wiring.
       */
      driveTasksOnIdle: z.boolean().default(false),
      /** Cap on how many tasks the scheduler starts on one tick. */
      tasksPerTick: z.number().int().min(1).max(64).default(4),
    })
    .default({
      maxToolIterations: 8,
      idleEventDriven: true,
      idleIntervalMs: 30_000,
      journalRetentionDays: 14,
      journalMaxPerDay: 1000,
      driveTasksOnIdle: false,
      tasksPerTick: 4,
    }),
  /**
   * Cross-device sync. Off by default. Local Vesper does not wait on the cloud.
   * Enabling this does not make personal memory globally shared — privacy classes
   * still default to private.
   */
  sync: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(["none", "local-mock", "cloudflare-stub"]).default("none"),
      privacyDefault: z.enum(["private", "device_only", "shared", "global"]).default("private"),
    })
    .default({ enabled: false, provider: "none", privacyDefault: "private" }),
  /**
   * Personal intelligence layer. Instincts never auto-promote to policy.
   * The graph is data, not a grant. External packets redact secrets.
   */
  intelligence: z
    .object({
      graph: z.boolean().default(true),
      instincts: z.boolean().default(true),
      jobs: z.boolean().default(true),
    })
    .default({ graph: true, instincts: true, jobs: true }),
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

/**
 * The built-in config as raw input, kept separate from `defaultConfig()` so recovery can
 * restore a single section. Several sections have a thin schema default (`workspaces:
 * []`) that is deliberately not the real default, so "drop the key and let zod fill it
 * in" is not good enough on its own.
 */
const DEFAULT_CONFIG_INPUT: Record<string, unknown> = {
  identity: { name: "Vesper", userName: "User" },
  workspaces: DEFAULT_WORKSPACES,
  approvedApps: DEFAULT_APPS,
  approvedRoots: ["notes", "docs", "knowledge"],
  obs: { enabled: false, url: "ws://127.0.0.1:4455", timeoutMs: 3000 },
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
};

export function defaultConfig(overrides?: Record<string, unknown>): VesperConfig {
  return vesperConfigSchema.parse({ ...DEFAULT_CONFIG_INPUT, ...overrides });
}

/** Sections that decide what Vesper is allowed to do, or where it is allowed to talk. */
const SECURITY_SECTIONS = [
  "permissions",
  "approvedRoots",
  "approvedApps",
  "knowledgeSources",
  "models",
  "optimizer",
  "dataDir",
];

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Enough rounds for a genuinely messy file; a config with more errors than this is broken. */
const MAX_RECOVERY_ROUNDS = 24;

type ConfigPath = (string | number)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a security section becomes when it cannot be read.
 *
 * The least authority the section can express: no approved roots means no filesystem
 * access, no approved applications means nothing may be launched, no knowledge sources
 * means nothing is indexed. The assistant still starts and still says what happened; it
 * simply cannot do the things the unreadable section was what authorised.
 */
const LOCKED_DOWN: Record<string, unknown> = {
  approvedRoots: [],
  approvedApps: [],
  knowledgeSources: [],
};

/**
 * The configuration to run on when the file could not be read at all.
 *
 * Distinct from a *validation* failure, which `removeExact` handles section by section:
 * this is the whole file being unparseable or unreadable, where nothing at all is known
 * about what the user intended. `defaultConfig()` is the vendor's permissive starting
 * point — it approves three filesystem roots, indexes two knowledge sources and carries
 * no tool overrides — so booting on it after a truncated write silently *granted* more
 * than the file it replaced. A user who had set `fs_read: "never"` and no approved roots
 * came back from a power cut with `fs_read` autonomous over three directories.
 *
 * The failure of a parser must never be the thing that grants authority.
 */
export function lockedDownConfig(): VesperConfig {
  const config = defaultConfig();
  return {
    ...config,
    approvedRoots: [],
    approvedApps: [],
    knowledgeSources: [],
    permissions: { ...config.permissions, lockedDown: true },
  };
}

function isSecurityPath(path: string): boolean {
  return SECURITY_SECTIONS.some((section) => path === section || path.startsWith(`${section}.`));
}

/**
 * Remove exactly one setting that failed validation.
 *
 * A whole top-level section is put back to its built-in value (once - a second failure on
 * the same section means the built-in value is not the problem, so the key is dropped and
 * the schema default applies); anything deeper is deleted; an invalid array element is
 * spliced out without disturbing its valid siblings.
 */
function removeExact(
  root: Record<string, unknown>,
  path: ConfigPath,
  restored: Set<string>,
): boolean {
  if (path.length === 0) return false;

  let parent: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(parent) && typeof segment === "number") parent = parent[segment];
    else if (isRecord(parent) && !UNSAFE_KEYS.has(String(segment))) parent = parent[String(segment)];
    else return false;
  }

  const last = path[path.length - 1];
  if (last === undefined) return false;

  if (Array.isArray(parent)) {
    const index = typeof last === "number" ? last : Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }
  if (!isRecord(parent)) return false;

  const key = String(last);
  if (
    path.length === 1 &&
    !UNSAFE_KEYS.has(key) &&
    key in DEFAULT_CONFIG_INPUT &&
    !restored.has(key)
  ) {
    restored.add(key);
    // A security section that failed validation is put back *locked down*, not put back
    // to the vendor's starting point.
    //
    // DEFAULT_CONFIG_INPUT is a permissive place to begin — approvedRoots already lists
    // notes, docs and knowledge — so restoring it silently widened a user who had
    // narrowed their own settings. The safe reading of "this section is unreadable" is
    // the least authority it could express, not the most convenient one.
    if (isSecurityPath(key) && key in LOCKED_DOWN) {
      parent[key] = structuredClone(LOCKED_DOWN[key]);
      return true;
    }
    parent[key] = structuredClone(DEFAULT_CONFIG_INPUT[key]);
    return true;
  }
  if (!Object.hasOwn(parent, key)) return false;
  // Never *assign* through a prototype key; deleting the own property is always safe.
  Reflect.deleteProperty(parent, key);
  return true;
}

/**
 * A "required field is missing" issue names a key that is not there to delete, so the
 * smallest thing that can actually be rejected is its container: the array element or
 * section that is incomplete.
 */
function removeEnclosing(
  root: Record<string, unknown>,
  path: ConfigPath,
  restored: Set<string>,
): string | null {
  for (let end = path.length - 1; end > 0; end -= 1) {
    const target = path.slice(0, end);
    if (removeExact(root, target, restored)) return target.join(".");
  }
  return null;
}

/** Deepest path first, and highest array index first, so a splice cannot shift a later target. */
function comparePathsDescending(a: ConfigPath, b: ConfigPath): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return right - left;
    return String(left) < String(right) ? 1 : -1;
  }
  return 0;
}

export interface ParsedConfig {
  config: VesperConfig;
  ok: boolean;
  errors: string[];
  /** Settings that failed validation and were reset to their built-in value. */
  rejected: string[];
  /** True when a rejected setting governs permissions, roots, or where Vesper connects. */
  securityRelevant: boolean;
}

/**
 * Parse a config, keeping every setting that validates and refusing every setting that
 * does not.
 *
 * The previous behaviour was to throw the entire config away on the first error and
 * return the built-in defaults. One typo in `voice.ttsModel` therefore reverted the
 * user's `permissions`, `approvedRoots`, and optimizer settings without saying which
 * ones - a silent downgrade that looked identical to a clean boot.
 *
 * Now each failing setting is dropped individually and named in `rejected`. Nothing that
 * could not be validated is kept: a rejected setting falls back to the built-in value,
 * never to the user's unvalidated one. If the file is too broken to recover, the whole
 * thing is refused and reported rather than partially applied.
 */
export function parseConfig(input: unknown): ParsedConfig {
  const errors: string[] = [];
  const rejected: string[] = [];

  const unrecoverable = (): ParsedConfig => ({
    config: defaultConfig(),
    ok: false,
    errors: errors.length ? [...new Set(errors)] : ["config could not be parsed"],
    rejected: ["<entire config>"],
    securityRelevant: true,
  });

  let candidate: unknown;
  try {
    // Recovery edits its input, so it must never touch the caller's object.
    candidate = structuredClone(input);
  } catch {
    return unrecoverable();
  }

  const restored = new Set<string>();
  let result = vesperConfigSchema.safeParse(candidate);
  for (let round = 0; !result.success && round < MAX_RECOVERY_ROUNDS; round += 1) {
    if (!isRecord(candidate)) break;
    const paths: ConfigPath[] = [];
    for (const issue of result.error.issues) {
      const path = issue.path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number",
      );
      errors.push(`${path.join(".") || "<root>"}: ${issue.message}`);
      if (path.length > 0) paths.push(path);
    }
    paths.sort(comparePathsDescending);
    let changed = false;
    for (const path of paths) {
      if (!removeExact(candidate, path, restored)) continue;
      rejected.push(path.join("."));
      changed = true;
    }
    if (!changed) {
      // Only one escalation per round: removing a container invalidates the sibling
      // paths this round already collected, so re-parse before touching anything else.
      for (const path of paths) {
        const removed = removeEnclosing(candidate, path, restored);
        if (!removed) continue;
        rejected.push(removed);
        changed = true;
        break;
      }
    }
    if (!changed) break;
    result = vesperConfigSchema.safeParse(candidate);
  }

  if (!result.success) return unrecoverable();
  const uniqueRejected = [...new Set(rejected)];
  return {
    config: result.data,
    ok: uniqueRejected.length === 0,
    errors: [...new Set(errors)],
    rejected: uniqueRejected,
    securityRelevant: uniqueRejected.some(isSecurityPath),
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
