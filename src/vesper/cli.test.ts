import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "./cli.ts";

describe("cli", () => {
  it("defaults to the REPL", () => {
    assert.deepEqual(parseCli([]), { kind: "repl", skipDiscovery: false });
  });

  it("parses one-shot commands and skip-discovery", () => {
    assert.equal(parseCli(["--version"]).kind, "version");
    assert.equal(parseCli(["--help"]).kind, "help");
    assert.deepEqual(parseCli(["--diagnostics", "--skip-discovery"]), {
      kind: "diagnostics",
      skipDiscovery: true,
    });
    assert.equal(parseCli(["--config-check"]).kind, "config-check");
  });

  it("rejects unknown and extra arguments", () => {
    assert.equal(parseCli(["--explode"]).kind, "unknown");
    assert.equal(parseCli(["--status", "--health"]).kind, "unknown");
  });
});
