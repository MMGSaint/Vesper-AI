#!/usr/bin/env node
/**
 * Vesper's focused adversarial security gate.
 *
 * This is the suite to run when touching anything near a trust boundary. It is
 * deliberately fast — seconds, not a fuzzing campaign — and deliberately end-to-end:
 * almost every file here drives a real runtime and asserts on what reached the disk, the
 * provider, or the tool record, rather than on what a function returned.
 *
 * The deeper campaign (long-running fuzzing, stress, and exhaustive path enumeration) is
 * described in docs/security-testing.md and is not run here.
 *
 * Each entry says which attack class it covers, so a gap in coverage is visible as a
 * missing line rather than as an absence nobody notices.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SUITE = [
  ["src/vesper/security.test.ts", "path confinement, executable safety, secret detection"],
  ["src/vesper/security-hostile.test.ts", "hostile inputs against every boundary"],
  ["src/vesper/security-invariants.test.ts", "the cross-cutting properties, as properties"],
  ["src/vesper/prompt-integrity.test.ts", "nothing but Vesper speaks in Vesper's voice"],
  ["src/vesper/untrusted.test.ts", "the untrusted-content boundary itself"],
  ["src/vesper/injection-redteam.test.ts", "prompt injection: containment"],
  ["src/vesper/injection-wiring.test.ts", "prompt injection: the product actually uses it"],
  ["src/vesper/tools/remote.test.ts", "remote authority limits at the tool gate"],
  ["src/vesper/tools/scope-enforcement.test.ts", "a scope governs its data on every route"],
  ["src/vesper/client/device-binding.test.ts", "device identity, trust, revocation"],
  ["src/vesper/client/confirmation-authority.test.ts", "the confirmation queue as a trust boundary"],
  ["src/vesper/memory/scopes.test.ts", "memory scope visibility and attribution"],
  ["src/vesper/distributed/discovery.test.ts", "capabilities are discovered, never assumed"],
];

const missing = SUITE.filter(([file]) => !existsSync(file));
if (missing.length > 0) {
  console.error("Security suite references files that do not exist:");
  for (const [file] of missing) console.error(`  ${file}`);
  console.error("Fix the list or restore the file; a silently shrinking suite is worse than none.");
  process.exit(1);
}

console.log(`Vesper security gate — ${SUITE.length} files`);
for (const [file, covers] of SUITE) console.log(`  ${file.replace("src/vesper/", "")}  · ${covers}`);
console.log("");

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...SUITE.map(([file]) => file)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
