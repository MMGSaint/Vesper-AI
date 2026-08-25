import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig, parseConfig, type VesperConfig } from "./config.ts";

export interface LoadedHostConfig {
  config: VesperConfig;
  source: "file" | "default";
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
      return {
        config: defaultConfig(),
        source: "default",
        ok: false,
        errors: [`${configPath} is not valid JSON; using defaults`],
        path: configPath,
      };
    }
    const parsed = parseConfig(parsedJson);
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
      config: defaultConfig(),
      source: "default",
      ok: false,
      errors: [`Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`],
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
