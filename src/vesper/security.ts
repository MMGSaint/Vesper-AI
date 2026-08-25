import { isAbsolute, relative, resolve, sep } from "node:path";

const SHELL_META = /[|&;<>`$()\n\r]/;
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._\-]+)\b/i;

export function containsTraversal(input: string): boolean {
  if (!input) return false;
  if (input.includes("\0")) return true;
  const normalized = input.replace(/\\/g, "/");
  return normalized.split("/").some((part) => part === "..");
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function isDangerousRoot(root: string): boolean {
  const trimmed = root.trim();
  if (!trimmed) return true;
  if (containsTraversal(trimmed)) return true;
  const unix = trimmed.replace(/\\/g, "/");
  if (unix === "/" || unix === ".") return true;
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) return true;
  if (/^\/(etc|windows|system32|home|users|root)(\/|$)/i.test(unix)) return true;
  if (/^[a-zA-Z]:\/(windows|users|program files)/i.test(unix)) return true;
  return false;
}

export function assertWithinRoot(root: string, candidate: string): string {
  if (candidate.includes("\0") || root.includes("\0")) {
    throw new Error("Path contains a null byte.");
  }
  if (containsTraversal(candidate)) {
    throw new Error("Path traversal is not allowed.");
  }
  const resolved = resolve(root, candidate);
  if (!isPathInside(root, resolved)) {
    throw new Error("Path escapes the approved root.");
  }
  return resolved;
}

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE.test(value);
}

export function isSafeExecutableName(name: string): boolean {
  if (!name || name.includes("\0")) return false;
  if (name.includes("/") || name.includes("\\") || name.includes(sep)) return false;
  if (SHELL_META.test(name)) return false;
  return SAFE_COMMAND.test(name);
}

export function assertNoShellMeta(value: string, label = "argument"): void {
  if (value.includes("\0") || SHELL_META.test(value)) {
    throw new Error(`Unsafe ${label}.`);
  }
}

export function parseTasklistCsv(csv: string): { pid: number; name: string; memoryMB?: number }[] {
  const rows: { pid: number; name: string; memoryMB?: number }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^"([^"]+)"\s*,\s*"(\d+)"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"([^"]*)"/);
    if (!match) continue;
    const name = match[1];
    const pid = Number(match[2]);
    const memRaw = match[3]?.replace(/[^\d]/g, "") ?? "";
    if (!name || !Number.isFinite(pid)) continue;
    rows.push({
      pid,
      name,
      memoryMB: memRaw ? Math.round(Number(memRaw) / 1024) : undefined,
    });
  }
  return rows;
}
