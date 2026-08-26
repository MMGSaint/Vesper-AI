/**
 * Build the installable Vesper artifact.
 *
 * Vesper runs TypeScript directly on Node 22, so "packaging" means assembling the tree
 * a Windows machine needs, not compiling. The artifact contains the runtime source, the
 * PowerShell installer, the lockfile, and a manifest naming the exact commit — enough
 * to install and run without this repository or any network access beyond `npm ci`.
 *
 * Deterministic: the same commit produces a byte-identical archive.
 *
 *   node scripts/package.mjs [--out dist]
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createZip } from "./zip.mjs";

const root = resolve(import.meta.dirname, "..");
const outFlag = process.argv.indexOf("--out");
const outDir = resolve(root, outFlag >= 0 ? (process.argv[outFlag + 1] ?? "dist") : "dist");

/** Everything the runtime needs on the target machine, and nothing else. */
const INCLUDE = [
  "src/vesper/**/*.ts",
  "packaging/windows/*",
  "knowledge/**/*.md",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "CLAUDE.md",
  "AGENTS.md",
  "SECURITY.md",
  "docs/**/*.md",
];

// Tests are not shipped: they are the development contract, not the product.
const EXCLUDE = /\.test\.ts$/;

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitDirty() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  } catch {
    return true;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const files = [
    ...new Set(INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: root }))),
  ]
    .filter((file) => !EXCLUDE.test(file))
    // Sorted so archive order never depends on filesystem order.
    .sort();

  if (files.length === 0) throw new Error("No files matched; refusing to build an empty artifact.");

  const entries = [];
  for (const file of files) {
    const data = await readFile(join(root, file));
    entries.push({ name: `vesper/${file.split(sep).join("/")}`, data });
  }

  const commit = gitCommit();
  const dirty = gitDirty();
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    commit,
    // A tree with uncommitted changes cannot be reproduced from the commit alone.
    reproducibleFromCommit: !dirty,
    node: pkg.engines?.node ?? ">=22",
    files: files.length,
    install: "Run packaging/windows/install.ps1 in PowerShell, then npm ci in the install root.",
    note: "Built on a development host. No Windows command, AMD telemetry, audio device, or local model was exercised to produce this artifact.",
  };
  entries.push({
    name: "vesper/PACKAGE.json",
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  });

  const zip = createZip(entries);
  await mkdir(outDir, { recursive: true });
  const artifact = join(outDir, `vesper-${pkg.version}.zip`);
  await writeFile(artifact, zip);

  const digest = createHash("sha256").update(zip).digest("hex");
  await writeFile(`${artifact}.sha256`, `${digest}  ${relative(outDir, artifact)}\n`, "utf8");

  console.log(`Packaged ${files.length + 1} files -> ${relative(root, artifact)}`);
  console.log(`sha256 ${digest}`);
  console.log(`commit ${commit}${dirty ? " (working tree dirty; not reproducible from this commit alone)" : ""}`);
}

await main();
