/**
 * A small glob matcher for knowledge source include/exclude patterns. Supports `**`,
 * `*` and `?`; it exists so configured filters can be honoured without pulling in a
 * dependency, and deliberately stops short of brace expansion and extglobs rather than
 * half-implementing them.
 */

const cache = new Map<string, RegExp>();

export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const glob = normalizeRelPath(pattern);
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${out}$`, "i");
  cache.set(pattern, regex);
  return regex;
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  const path = normalizeRelPath(relPath);
  const regex = globToRegExp(pattern);
  if (regex.test(path)) return true;
  // A pattern with no separator is a name filter, so `*.md` and `notes.md` match at any
  // depth — the convention users already expect from .gitignore.
  if (!normalizeRelPath(pattern).includes("/")) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return regex.test(base);
  }
  return false;
}

export function matchesAnyGlob(relPath: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.some((pattern) => matchesGlob(relPath, pattern));
}

/**
 * Whether a directory can be skipped entirely. Only an optimisation: files are filtered
 * individually regardless, so a pattern this misses still excludes its files.
 */
export function excludesDirectory(relDir: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length || !relDir) return false;
  return patterns.some((pattern) => {
    const trimmed = normalizeRelPath(pattern).replace(/\/\*\*$/, "").replace(/\/+$/, "");
    return trimmed.length > 0 && matchesGlob(relDir, trimmed);
  });
}

export function includesFile(
  relPath: string,
  filters: { include?: string[]; exclude?: string[] } | undefined,
): boolean {
  if (!filters) return true;
  if (filters.include?.length && !matchesAnyGlob(relPath, filters.include)) return false;
  return !matchesAnyGlob(relPath, filters.exclude);
}
