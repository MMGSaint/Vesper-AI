import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger, redactObject } from "./logging.ts";

describe("logging", () => {
  it("redacts secrets and records structured entries", () => {
    const log = createLogger();
    log.info("model", "request", {
      api_key: "sk-secret",
      token: "abc",
      model: "qwen",
    });
    const entry = log.recent(1)[0];
    assert.equal(entry?.data?.api_key, "[redacted]");
    assert.equal(entry?.data?.token, "[redacted]");
    assert.equal(entry?.data?.model, "qwen");
    assert.equal(redactObject({ password: "x", nested: { authorization: "Bearer" } })?.password, "[redacted]");
  });
});
