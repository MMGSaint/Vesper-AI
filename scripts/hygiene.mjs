#!/usr/bin/env node
/**
 * Repository hygiene for a public Vesper tree.
 * Fails CI if workflows lack least-privilege permissions or if
 * high-confidence secret material is committed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "data",
]);
const SKIP_FILES = new Set(["package-lock.json", "scripts/hygiene.mjs"]);
const DOC_FILES = new Set([
  "SECURITY.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/security.md",
  "docs/GITHUB_SECURITY.md",
]);

const TEXT_EXT = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".ps1",
  ".cmd",
  ".txt",
  ".gitignore",
]);

const SECRET =
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9]{20,}|sk-(?:proj-|or-)?[A-Za-z0-9]{20,}|BEGIN (?:RSA|OPENSSH|EC|DSA|OPENSSH) PRIVATE KEY)\b/;

const errors = [];
const notes = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(ROOT, full).replaceAll("\\", "/");
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push({ full, rel });
  }
  return out;
}

function isTest(rel) {
  return rel.includes(".test.") || rel.endsWith(".test.ts");
}

function isRegexLine(line) {
  return /A-Za-z0-9/.test(line) || line.includes("SECRET_VALUE") || line.includes("SECRET_KEY");
}

const files = walk(ROOT);

for (const { full, rel } of files) {
  if (SKIP_FILES.has(rel)) continue;
  const ext = extname(rel) || (rel.startsWith(".") ? rel : "");
  if (rel.endsWith(".env") || (rel.startsWith(".env.") && rel !== ".env.example")) {
    errors.push(`Committed env file: ${rel}`);
    continue;
  }
  if (rel.endsWith(".pem") || rel.endsWith(".key") || rel.endsWith(".p12")) {
    errors.push(`Committed key material: ${rel}`);
    continue;
  }
  if (!TEXT_EXT.has(ext) && !rel.endsWith("Dockerfile") && !rel.endsWith("LICENSE")) continue;
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  if (isTest(rel) || DOC_FILES.has(rel)) continue;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isRegexLine(line)) return;
    const match = line.match(SECRET);
    if (match) {
      errors.push(`${rel}:${i + 1} looks like a committed secret (${match[1].slice(0, 8)}…)`);
    }
  });
}

const workflowDir = join(ROOT, ".github", "workflows");
try {
  for (const name of readdirSync(workflowDir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const rel = `.github/workflows/${name}`;
    const text = readFileSync(join(workflowDir, name), "utf8");
    if (!/^permissions\s*:/m.test(text)) {
      errors.push(`${rel} is missing a top-level permissions: block`);
    }
    if (/permissions\s*:\s*write-all/.test(text) || /contents\s*:\s*write/.test(text) && /pull_request_target/.test(text)) {
      errors.push(`${rel} uses a dangerous permissions combination`);
    }
    if (/pull_request_target/.test(text)) {
      errors.push(`${rel} uses pull_request_target; review before keeping it`);
    }
  }
} catch (error) {
  errors.push(`Cannot read workflows: ${error instanceof Error ? error.message : String(error)}`);
}

if (files.some((f) => f.rel === ".env" || (f.rel.startsWith(".env.") && f.rel !== ".env.example"))) {
  errors.push("A .env file is tracked");
}

if (errors.length) {
  console.error("Hygiene failed:");
  for (const err of errors) console.error(` - ${err}`);
  process.exit(1);
}

console.log(`Hygiene passed (${files.length} files scanned).`);
for (const note of notes) console.log(note);
