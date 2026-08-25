import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "./types.ts";

export interface StorageAdapter {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryStorage implements StorageAdapter {
  private data = new Map<string, JsonValue>();

  constructor(seed?: Record<string, JsonValue>) {
    if (seed) {
      for (const [key, value] of Object.entries(seed)) this.data.set(key, value);
    }
  }

  async get(key: string) {
    return this.data.get(key);
  }

  async set(key: string, value: JsonValue) {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string) {
    this.data.delete(key);
  }

  async keys() {
    return [...this.data.keys()];
  }

  snapshot(): Record<string, JsonValue> {
    return Object.fromEntries(this.data.entries());
  }
}

export class FileStorage implements StorageAdapter {
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private cache: Record<string, JsonValue> | null = null;

  private async load(): Promise<Record<string, JsonValue>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.cache = {};
        return this.cache;
      }
      this.cache = parsed as Record<string, JsonValue>;
      return this.cache;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = {};
        return this.cache;
      }
      throw error;
    }
  }

  private async persist() {
    const data = this.cache ?? {};
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async get(key: string) {
    const data = await this.load();
    return data[key];
  }

  async set(key: string, value: JsonValue) {
    const data = await this.load();
    data[key] = value;
    await this.persist();
  }

  async delete(key: string) {
    const data = await this.load();
    delete data[key];
    await this.persist();
  }

  async keys() {
    return Object.keys(await this.load());
  }
}

export async function loadJsonOrDefault<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; corrupted: boolean; usedDefault: boolean }> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as T;
    return { value: parsed, corrupted: false, usedDefault: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { value: fallback, corrupted: false, usedDefault: true };
    }
    return { value: fallback, corrupted: true, usedDefault: true };
  }
}
