import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig, lockedDownConfig, parseConfig, type VesperConfig } from "./config.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a config file over the built-in defaults.
 *
 * The on-disk file is deliberately a *subset* of the full config, so a key that is
 * absent from it must mean "use the default", never "empty". Parsing the file on its
 * own let schema defaults such as `workspaces: []` win over the real defaults, which
 * silently left a real installation with no workspaces, no approved applications, and
 * no knowledge sources.
 *
 * Objects merge recursively so a partially written section (for example `hardware`,
 * which only stores mode and target) keeps the rest of its defaults. Arrays replace
 * wholesale, so a user who deliberately writes `"approvedApps": []` gets an empty list.
 */
export function mergeOverDefaults(
  base: Record<string, unknown>,
  override: unknown,
): Record<string, unknown> {
  if (!isPlainObject(override)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // Never let a config file introduce prototype keys.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? mergeOverDefaults(current, value)
      : value;
  }
  return out;
}

export interface LoadedHostConfig {
  config: VesperConfig;
  /**
   * Where the running configuration came from.
   *
   * `locked-down` means the file existed but could not be read or parsed, so Vesper is
   * running on the *narrowest* configuration rather than on the vendor defaults. It is
   * a distinct value from `default` (no file yet, a first boot) because the two mean
   * opposite things about the user's intent.
   */
  source: "file" | "default" | "locked-down";
  ok: boolean;
  errors: string[];
  path: string;
}

export async function loadHostConfig(configPath: string): Promise<LoadedHostConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      // Locked down, not defaulted. See `lockedDownConfig`: the built-in defaults are
      // broader than most real files, so booting on them after a truncated write is the
      // parse failure granting authority the user had taken away.
      return {
        config: lockedDownConfig(),
        source: "locked-down",
        ok: false,
        errors: [
          `${configPath} is not valid JSON. Starting with no approved roots, no approved ` +
            `applications and no knowledge sources until it is repaired.`,
        ],
        path: configPath,
      };
    }
    const parsed = parseConfig(
      mergeOverDefaults(defaultConfig() as unknown as Record<string, unknown>, parsedJson),
    );
    return {
      config: parsed.config,
      source: parsed.ok ? "file" : "default",
      ok: parsed.ok,
      errors: parsed.ok ? [] : parsed.errors,
      path: configPath,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        config: defaultConfig(),
        source: "default",
        ok: true,
        errors: [],
        path: configPath,
      };
    }
    return {
      config: lockedDownConfig(),
      source: "locked-down",
      ok: false,
      errors: [
        `Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Starting with no approved roots, no approved applications and no knowledge sources.`,
      ],
      path: configPath,
    };
  }
}

export async function writeConfigIfMissing(configPath: string, config: VesperConfig): Promise<boolean> {
  try {
    await readFile(configPath, "utf8");
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  await mkdir(dirname(configPath), { recursive: true });
  const publicConfig = {
    identity: config.identity,
    hardware: { mode: config.hardware.mode, target: config.hardware.target },
    models: {
      allowOptionalCloud: config.models.allowOptionalCloud,
      roles: config.models.roles,
      fallback: config.models.fallback,
      endpoints: config.models.endpoints,
    },
    optimizer: {
      mode: config.optimizer.mode,
      endpoint: config.optimizer.endpoint,
      timeoutMs: config.optimizer.timeoutMs,
      retries: config.optimizer.retries,
    },
    voice: config.voice,
    windows: config.windows,
    agent: config.agent,
    approvedRoots: config.approvedRoots,
  };
  await writeFile(configPath, `${JSON.stringify(publicConfig, null, 2)}\n`, "utf8");
  return true;
}
