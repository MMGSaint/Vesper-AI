import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SHELL_META = /[|&;<>`$()\n\r]/;
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/;
/**
 * Values that are credentials rather than notes.
 *
 * The previous pattern required the token body to be unbroken alphanumerics, so
 * `sk-[A-Za-z0-9]{16,}` could not match `sk-live-...` or `sk-proj-...` — the hyphen ends
 * the run immediately after the prefix, and nearly every modern key has one. It matched
 * a shape almost no real key takes.
 *
 * Recognised by issuer prefix where one exists, because a prefix is a fact about the
 * token rather than a guess about entropy, plus one shape that carries its own label
 * ("api_key = <something long>"). Deliberately not a general high-entropy test: this
 * decides what is withheld from sync and redacted from logs, and a heuristic that
 * swallowed ordinary notes would cost the user their own memories.
 */
const SECRET_VALUE = new RegExp(
  [
    // OpenAI and Anthropic, including project- and environment-scoped forms.
    "sk-[A-Za-z0-9_-]{16,}",
    // GitHub: classic, fine-grained, and the app/refresh variants.
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    // GitLab, Slack, Google, AWS, Stripe, SendGrid, xAI.
    "glpat-[A-Za-z0-9_-]{16,}",
    "xox[baprs]-[A-Za-z0-9-]{10,}",
    "AIza[0-9A-Za-z_-]{30,}",
    "AKIA[0-9A-Z]{16}",
    "(?:r|s)k_(?:live|test)_[A-Za-z0-9]{16,}",
    "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
    "xai-[A-Za-z0-9_-]{16,}",
    // A bearer token, and a JSON Web Token anywhere.
    "Bearer\\s+[A-Za-z0-9._~+/-]{16,}",
    "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    // A value that names itself: "api_key: <20+ non-space characters>".
    "(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\\s*[:=]\\s*\\S{12,}",
  ].join("|"),
  "i",
);

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

/**
 * Directories that are never a legitimate approved root, at any depth. These belong to
 * the operating system, not the user.
 */
const SYSTEM_DIRECTORIES =
  /^(?:[a-zA-Z]:)?\/(etc|proc|sys|dev|boot|root|windows|winnt|program files( \(x86\))?|programdata|\$recycle\.bin)(\/|$)/i;

/** `System32` is dangerous wherever it appears, not only directly under a drive root. */
const SYSTEM32 = /(^|\/)system32(\/|$)/i;

/**
 * Containers holding every user's profile, and a whole profile itself. Approving one of
 * these means approving somebody's entire home directory, which is too broad - but
 * anything *inside* a profile is exactly where a user's notes and projects live and
 * must remain approvable.
 *
 *   C:/Users          -> refused (every profile)
 *   C:/Users/sam      -> refused (a whole profile)
 *   C:/Users/sam/notes-> allowed
 */
const PROFILE_CONTAINER = /^(?:[a-zA-Z]:)?\/(home|users)(?:\/[^/]+)?$/i;

export function isDangerousRoot(root: string): boolean {
  const trimmed = root.trim();
  if (!trimmed) return true;
  if (containsTraversal(trimmed)) return true;

  // Normalise separators, collapse repeated ones, and drop trailing slashes so
  // "C:\\Users\\", "C:/Users" and "//etc" are all judged as what they actually address.
  // Leaving repeats in place meant "//etc" and "//home" were not recognised as system
  // directories at all, while the operating system resolves them exactly like "/etc".
  const unix = trimmed
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (unix === "" || unix === "/" || unix === ".") return true;
  // A bare drive: "C:", "C:\", "C:/".
  if (/^[a-zA-Z]:$/.test(unix)) return true;

  if (SYSTEM_DIRECTORIES.test(unix)) return true;
  if (SYSTEM32.test(unix)) return true;
  if (PROFILE_CONTAINER.test(unix)) return true;

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

/**
 * Resolve a path and confirm it is *really* inside a root, following symlinks.
 *
 * `assertWithinRoot` compares strings, which a symlink defeats: a link inside an
 * approved directory pointing at `/etc/shadow` passes a lexical check and is then read.
 * This resolves both sides with `realpath` before comparing.
 *
 * For a path that does not exist yet (a pending write) the nearest existing ancestor is
 * resolved instead, so a link somewhere along the parent chain cannot redirect the
 * write either.
 */
export async function resolveRealWithinRoot(
  root: string,
  candidate: string,
): Promise<{ ok: true; path: string; root: string } | { ok: false; reason: string }> {
  let lexical: string;
  try {
    lexical = assertWithinRoot(root, candidate);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const realRoot = await realpathOrSelf(resolve(root));
  const realCandidate = await realpathDeepest(lexical);

  if (!isPathInside(realRoot, realCandidate)) {
    return {
      ok: false,
      reason: "Path resolves outside its approved root once symlinks are followed.",
    };
  }
  // Hand back the real paths so the caller opens exactly what was checked, and so a
  // root that is itself a symlink still produces correct relative paths.
  return { ok: true, path: realCandidate, root: realRoot };
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

/** realpath the deepest existing ancestor, then re-attach the missing tail. */
async function realpathDeepest(target: string): Promise<string> {
  const absolute = resolve(target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return tail.length ? resolve(resolved, ...tail.reverse()) : resolved;
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Vesper's own directories
// ---------------------------------------------------------------------------

/**
 * Paths belonging to Vesper itself, which its own tools and indexer must never read.
 *
 * The data directory holds the device's private key, the audit trail, the device
 * registry and the memory store. None of that is a document, and the knowledge indexer
 * had no way to know it: point a knowledge root at a parent of the data directory — or
 * approve a home directory that contains it — and the private key came back as a search
 * hit, reachable by any companion holding knowledge.read.
 *
 * Deliberately a deny-list of *Vesper's own* paths rather than a guess about what is
 * sensitive in general. It is set once at startup from the directories the host was
 * actually given, so it cannot drift from where the files really are.
 */
const OWN_PATHS = new Set<string>();

export function registerOwnPaths(paths: (string | undefined)[]): void {
  for (const path of paths) {
    if (!path) continue;
    OWN_PATHS.add(resolve(path));
  }
}

/** Exposed for tests; production sets this once at startup and never clears it. */
export function clearOwnPaths(): void {
  OWN_PATHS.clear();
}

export function isVesperOwnPath(candidate: string): boolean {
  if (OWN_PATHS.size === 0) return false;
  const target = resolve(candidate);
  for (const own of OWN_PATHS) {
    if (target === own || isPathInside(own, target)) return true;
  }
  return false;
}
