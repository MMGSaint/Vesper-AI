import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logging.ts";
import { createJsonlSink } from "./audit-file.ts";

describe("audit file", () => {
  it("appends redacted JSONL entries", async () => {
    const dir = join(tmpdir(), `vesper-audit-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "audit.jsonl");
    const log = createLogger({ sink: createJsonlSink(path) });
    log.info("lifecycle", "started", { api_key: "sk-should-not-land" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("sk-should-not-land"), false);
    assert.equal(raw.includes("[redacted]"), true);
    assert.equal(raw.includes("started"), true);
  });
});
