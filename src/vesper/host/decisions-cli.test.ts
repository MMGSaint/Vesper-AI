import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", MAIN, ...args, "--skip-discovery"],
      { cwd, timeout: 120_000, env: { ...process.env, VESPER_SKIP_DISCOVERY: "1" } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function describe_(r: { code: number; stdout: string; stderr: string }): string {
  return [
    `exit=${r.code}`,
    `stdout(${r.stdout.length})=${JSON.stringify(r.stdout.slice(0, 400))}`,
    `stderr(${r.stderr.length})=${JSON.stringify(r.stderr.slice(0, 800))}`,
  ].join(" ");
}

describe("--decisions is a one-shot diagnostic", () => {
  it("prints a report and exits 0 even when nothing has happened", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vesper-decisions-"));
    const result = await run(["--decisions"], cwd);
    assert.equal(result.code, 0, describe_(result));
    assert.match(result.stdout, /No autonomy decisions are on record|Autonomy decisions/i, describe_(result));
  });

  it("--help lists --decisions, the same surface parseCli recognises", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vesper-decisions-help-"));
    const result = await run(["--help"], cwd);
    assert.equal(result.code, 0, describe_(result));
    assert.match(result.stdout, /--decisions/, describe_(result));
    assert.doesNotMatch(result.stdout, /Unknown command/, describe_(result));
  });
});
