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
import { existsSync, globSync } from "node:fs";
import { sep } from "node:path";

const SUITE = [
  ["src/vesper/permissions.test.ts", "the classifier itself, including the never-tier escalation"],
  ["src/vesper/security.test.ts", "path confinement, executable safety, secret detection"],
  ["src/vesper/security-hostile.test.ts", "hostile inputs against every boundary"],
  ["src/vesper/security-invariants.test.ts", "the cross-cutting properties, as properties"],
  ["src/vesper/prompt-integrity.test.ts", "nothing but Vesper speaks in Vesper's voice"],
  ["src/vesper/untrusted.test.ts", "the untrusted-content boundary itself"],
  ["src/vesper/untrusted-pipeline.test.ts", "sanitisation reaches a fixed point"],
  ["src/vesper/injection-redteam.test.ts", "prompt injection: containment"],
  ["src/vesper/injection-wiring.test.ts", "prompt injection: the product actually uses it"],
  ["src/vesper/tools/remote.test.ts", "remote authority limits at the tool gate"],
  ["src/vesper/tool-executor.test.ts", "a scheduled task reaches tools only through the authorization chain"],
  ["src/vesper/tools/scope-enforcement.test.ts", "a scope governs its data on every route"],
  ["src/vesper/tools/filesystem-containment.test.ts", "writes and reads never escape an approved root"],
  ["src/vesper/tools/filesystem-rollback.test.ts", "an undo never escapes an approved root either"],
  ["src/vesper/client/gateway.test.ts", "gateway method scopes and session authentication"],
  ["src/vesper/client/device-binding.test.ts", "device identity, trust, revocation"],
  ["src/vesper/client/confirmation-authority.test.ts", "the confirmation queue as a trust boundary"],
  ["src/vesper/security-corrections.test.ts", "a correction is evidence and never authority"],
  ["src/vesper/memory/scopes.test.ts", "memory scope visibility and attribution"],
  ["src/vesper/security-nexus-boundary.test.ts", "the optimizer specialist is data, never authority"],
  ["src/vesper/security-startup.test.ts", "startup registration and config patching are not authority surfaces"],
  ["src/vesper/security-decisions.test.ts", "decision journal is evidence; remote task_create keeps its author"],
  ["src/vesper/security-hardening.test.ts", "procedures, skills, compaction, and retries cannot bypass the gate"],
  ["src/vesper/distributed/discovery.test.ts", "capabilities are discovered, never assumed"],
  ["src/vesper/logging.test.ts", "secret redaction on the audit path"],
  ["src/vesper/resource-bounds.test.ts", "nothing untrusted chooses how much the host allocates"],
];

/**
 * Files that must be in the suite, matched by what they are rather than by name.
 *
 * A vanished listed file already fails loudly below. The opposite gap had nothing
 * watching it: `permissions.test.ts` is the only place the never-tier *escalation* is
 * covered as a unit — the rule that stops a tool whose author declared it "safe" from
 * running autonomously — and it was never listed, so deleting the escalation left the
 * gate green. `gateway.test.ts` and `logging.test.ts` were in the same position.
 *
 * This is not a substitute for a real test: it only catches a security-relevant file
 * being written and then forgotten.
 */
const MUST_BE_LISTED = [
  /^src\/vesper\/security.*\.test\.ts$/,
  /^src\/vesper\/permissions\.test\.ts$/,
  /^src\/vesper\/untrusted.*\.test\.ts$/,
  /^src\/vesper\/injection-.*\.test\.ts$/,
  /^src\/vesper\/logging\.test\.ts$/,
  /^src\/vesper\/resource-bounds\.test\.ts$/,
  /^src\/vesper\/prompt-integrity\.test\.ts$/,
  /^src\/vesper\/client\/.*\.test\.ts$/,
  /^src\/vesper\/tools\/(remote|scope-enforcement|filesystem-containment|filesystem-rollback)\.test\.ts$/,
];

const listed = new Set(SUITE.map(([file]) => file));
const shouldBeListed = globSync("src/vesper/**/*.test.ts")
  .map((file) => file.split(sep).join("/"))
  .filter((file) => MUST_BE_LISTED.some((pattern) => pattern.test(file)))
  .filter((file) => !listed.has(file));
if (shouldBeListed.length > 0) {
  console.error("Security-relevant test files exist but are not in the suite:");
  for (const file of shouldBeListed) console.error(`  ${file}`);
  console.error("Add them to SUITE, or narrow MUST_BE_LISTED and say why in a comment.");
  process.exit(1);
}

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
