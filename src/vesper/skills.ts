/**
 * Skill lifecycle and a lightweight scanner.
 *
 * A skill is metadata plus a trust state. Finding a manifest on disk is not
 * authorization. Third-party skills never become enabled just because they exist.
 *
 * Lifecycle: DISCOVERED → VALIDATED → SCANNED → ENABLED
 * Terminal: DISABLED | BLOCKED | UNAVAILABLE
 *
 * The permission gate remains authoritative. Enabling a skill does not register tools
 * by itself; a later loader would still go through ToolRegistry.
 *
 * No marketplace. No downloads. No model-supplied command strings.
 */

import { createId, nowIso } from "./id.ts";
import type { JsonValue } from "./types.ts";
import type { StorageAdapter } from "./storage.ts";

export const SKILL_STATES = [
  "discovered",
  "validated",
  "scanned",
  "enabled",
  "disabled",
  "blocked",
  "unavailable",
] as const;
export type SkillState = (typeof SKILL_STATES)[number];

export const SKILL_TRUSTS = ["builtin", "local", "third_party"] as const;
export type SkillTrust = (typeof SKILL_TRUSTS)[number];

export const SKILL_FINDING_SEVERITIES = ["info", "warn", "block"] as const;
export type SkillFindingSeverity = (typeof SKILL_FINDING_SEVERITIES)[number];

const KEY = "skills.entries";
const MAX_SKILLS = 64;

const SUSPICIOUS_BINARIES = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "sh",
  "wscript",
  "cscript",
  "mshta",
  "rundll32",
  "reg",
  "reg.exe",
  "bitsadmin",
  "curl",
  "wget",
  "npx",
  "python",
  "python3",
  "node",
]);

const SECRETISH =
  /(?:api[_-]?key|secret|password|token|credential|private[_-]?key|begin private)/i;

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  requiredTools: string[];
  requiredCapabilities: string[];
  platforms: string[];
  requiredBinaries: string[];
  requiredEnvironment: string[];
  trust: SkillTrust;
}

export interface SkillFinding {
  id: string;
  severity: SkillFindingSeverity;
  message: string;
}

export interface SkillRecord {
  id: string;
  manifest: SkillManifest;
  state: SkillState;
  findings: SkillFinding[];
  path?: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface SkillScanContext {
  knownTools?: Iterable<string>;
  knownCapabilities?: Iterable<string>;
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export function scanSkill(manifest: unknown, context: SkillScanContext = {}): {
  manifest?: SkillManifest;
  findings: SkillFinding[];
  state: SkillState;
} {
  const findings: SkillFinding[] = [];
  const parsed = parseManifest(manifest, findings);
  if (!parsed) {
    return { findings, state: "blocked" };
  }

  const knownTools = new Set(context.knownTools ?? []);
  const knownCaps = new Set(context.knownCapabilities ?? []);
  const manifestFields = parsed.manifest;

  if (manifestFields.requiredTools.length && knownTools.size) {
    for (const tool of manifestFields.requiredTools) {
      if (!knownTools.has(tool)) {
        findings.push({
          id: "undeclared-tool",
          severity: "block",
          message: `Required tool '${tool}' is not in the catalog.`,
        });
      }
    }
  }
  if (manifestFields.requiredCapabilities.length && knownCaps.size) {
    for (const cap of manifestFields.requiredCapabilities) {
      if (!knownCaps.has(cap)) {
        findings.push({
          id: "undeclared-capability",
          severity: "warn",
          message: `Required capability '${cap}' is not reported by this device.`,
        });
      }
    }
  }

  for (const binary of manifestFields.requiredBinaries) {
    const base = binary.split(/[\\/]/).pop()?.toLowerCase() ?? binary.toLowerCase();
    if (SUSPICIOUS_BINARIES.has(base)) {
      findings.push({
        id: "suspicious-binary",
        severity: "block",
        message: `Required binary '${binary}' is not an allowlisted application.`,
      });
    }
    if (binary.includes("..") || binary.includes(":") || binary.startsWith("/") || binary.startsWith("\\")) {
      findings.push({
        id: "invalid-path",
        severity: "block",
        message: `Required binary '${binary}' is a path, not a name.`,
      });
    }
  }

  for (const env of manifestFields.requiredEnvironment) {
    if (SECRETISH.test(env) || env.includes("=")) {
      findings.push({
        id: "secret-leak",
        severity: "block",
        message: "Manifest environment must be names, not values or secret-bearing keys.",
      });
    }
  }

  const blob = `${manifestFields.description} ${manifestFields.name}`;
  if (SECRETISH.test(blob)) {
    findings.push({
      id: "secret-leak",
      severity: "block",
      message: "Manifest text looks like it contains a secret.",
    });
  }

  if (parsed.pathHasExecLayout) {
    findings.push({
      id: "unsafe-layout",
      severity: "block",
      message: "Skill directory looks like it contains executables; Vesper will not load those.",
    });
  }

  const blocked = findings.some((finding) => finding.severity === "block");
  if (blocked) return { manifest: manifestFields, findings, state: "blocked" };
  return { manifest: manifestFields, findings, state: "scanned" };
}

export class SkillRegistry {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private items = new Map<string, SkillRecord>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.storage.get(KEY);
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const parsed = coerceRecord(item);
        if (parsed) this.items.set(parsed.id, parsed);
      }
    } catch {
      this.items = new Map();
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.items.values()] as unknown as JsonValue).catch(() => undefined);
  }

  async discover(manifest: unknown, options?: { path?: string } & SkillScanContext): Promise<SkillRecord> {
    return this.runExclusive(async () => {
      await this.load();
      if (this.items.size >= MAX_SKILLS) throw new SkillError(`Already holding ${MAX_SKILLS} skills.`);
      const now = nowIso();
      const scanned = scanSkill(manifest, options);
      const record: SkillRecord = {
        id: createId("skill"),
        manifest: scanned.manifest ?? fallbackManifest(manifest),
        state: scanned.state === "blocked" ? "blocked" : scanned.manifest ? "scanned" : "blocked",
        findings: scanned.findings,
        path: options?.path,
        discoveredAt: now,
        updatedAt: now,
      };
      // Discover → validate is folded into scanSkill (malformed → blocked).
      if (record.state !== "blocked" && scanned.manifest) {
        record.state = "scanned";
      }
      this.items.set(record.id, record);
      await this.persist();
      return { ...record, findings: [...record.findings], manifest: { ...record.manifest } };
    });
  }

  async enable(id: string): Promise<SkillRecord> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      if (!item) throw new SkillError("No such skill.");
      if (item.state === "blocked") throw new SkillError("A blocked skill cannot be enabled.");
      if (item.state !== "scanned" && item.state !== "disabled") {
        throw new SkillError(`Skill is ${item.state}, not scanned.`);
      }
      if (item.findings.some((finding) => finding.severity === "block")) {
        throw new SkillError("Skill still has blocking findings.");
      }
      // Third-party skills still need this explicit enable; discover never auto-enables.
      item.state = "enabled";
      item.updatedAt = nowIso();
      await this.persist();
      return { ...item, findings: [...item.findings], manifest: { ...item.manifest } };
    });
  }

  async disable(id: string): Promise<SkillRecord> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      if (!item) throw new SkillError("No such skill.");
      if (item.state === "blocked") throw new SkillError("A blocked skill stays blocked.");
      item.state = "disabled";
      item.updatedAt = nowIso();
      await this.persist();
      return { ...item, findings: [...item.findings], manifest: { ...item.manifest } };
    });
  }

  async list(): Promise<SkillRecord[]> {
    await this.runExclusive(async () => this.load());
    return [...this.items.values()].map((item) => ({
      ...item,
      findings: [...item.findings],
      manifest: { ...item.manifest },
    }));
  }

  async get(id: string): Promise<SkillRecord | undefined> {
    return (await this.list()).find((item) => item.id === id);
  }
}

interface ParsedManifest {
  manifest: SkillManifest;
  pathHasExecLayout: boolean;
}

function parseManifest(raw: unknown, findings: SkillFinding[]): ParsedManifest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    findings.push({ id: "malformed", severity: "block", message: "Manifest is not an object." });
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const required = ["name", "version", "description"] as const;
  for (const field of required) {
    if (typeof rec[field] !== "string" || !(rec[field] as string).trim()) {
      findings.push({ id: "missing-field", severity: "block", message: `Missing '${field}'.` });
    }
  }
  if (findings.some((finding) => finding.id === "missing-field" || finding.id === "malformed")) {
    return undefined;
  }
  const name = String(rec.name).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    findings.push({ id: "malformed", severity: "block", message: "Skill name must be a simple identifier." });
    return undefined;
  }
  const version = String(rec.version).trim();
  if (!/^[0-9]+(\.[0-9]+){0,3}[A-Za-z0-9._-]*$/.test(version)) {
    findings.push({ id: "malformed", severity: "block", message: "Version looks invalid." });
    return undefined;
  }
  const trust: SkillTrust = rec.trust === "builtin" || rec.trust === "local" ? rec.trust : "third_party";
  const pathHasExecLayout =
    (typeof rec.path === "string" && /\.(exe|bat|cmd|ps1|sh)$/i.test(rec.path)) ||
    (Array.isArray(rec.files) && rec.files.some((file) => typeof file === "string" && /\.(exe|bat|cmd|ps1)$/i.test(file)));
  return {
    pathHasExecLayout,
    manifest: {
      name,
      version,
      description: String(rec.description).trim().slice(0, 500),
      requiredTools: stringList(rec.requiredTools),
      requiredCapabilities: stringList(rec.requiredCapabilities),
      platforms: stringList(rec.platforms),
      requiredBinaries: stringList(rec.requiredBinaries),
      requiredEnvironment: stringList(rec.requiredEnvironment),
      trust,
    },
  };
}

function fallbackManifest(raw: unknown): SkillManifest {
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim().slice(0, 80) : "unknown",
    version: typeof rec.version === "string" ? rec.version : "0",
    description: typeof rec.description === "string" ? rec.description.slice(0, 200) : "",
    requiredTools: [],
    requiredCapabilities: [],
    platforms: [],
    requiredBinaries: [],
    requiredEnvironment: [],
    trust: "third_party",
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 32);
}

function coerceRecord(raw: unknown): SkillRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Partial<SkillRecord>;
  if (typeof rec.id !== "string" || !rec.manifest) return null;
  const scanned = scanSkill(rec.manifest);
  if (!scanned.manifest && rec.state !== "blocked") return null;
  const state = SKILL_STATES.includes(rec.state as SkillState) ? (rec.state as SkillState) : "discovered";
  return {
    id: rec.id,
    manifest: scanned.manifest ?? fallbackManifest(rec.manifest),
    state: state === "enabled" && scanned.state === "blocked" ? "blocked" : state,
    findings: Array.isArray(rec.findings) ? rec.findings.filter(isFinding) : scanned.findings,
    path: typeof rec.path === "string" ? rec.path : undefined,
    discoveredAt: typeof rec.discoveredAt === "string" ? rec.discoveredAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}

function isFinding(value: unknown): value is SkillFinding {
  if (!value || typeof value !== "object") return false;
  const rec = value as SkillFinding;
  return typeof rec.id === "string" && typeof rec.message === "string";
}
