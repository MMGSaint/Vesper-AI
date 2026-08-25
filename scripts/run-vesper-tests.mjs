import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = globSync("src/vesper/**/*.test.ts");
if (files.length === 0) {
  console.error("No Vesper tests found under src/vesper.");
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
