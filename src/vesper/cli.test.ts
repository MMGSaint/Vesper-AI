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
    assert.equal(parseCli(["--export-memory"]).kind, "export-memory");
    assert.equal(parseCli(["--client-hello"]).kind, "client-hello");
    assert.equal(parseCli(["--first-boot-report"]).kind, "first-boot-report");
    assert.equal(parseCli(["--startup-status"]).kind, "startup-status");
    assert.equal(parseCli(["--enable-startup"]).kind, "enable-startup");
    assert.equal(parseCli(["--disable-startup"]).kind, "disable-startup");
  });

  it("rejects unknown and extra arguments", () => {
    assert.equal(parseCli(["--explode"]).kind, "unknown");
    assert.equal(parseCli(["--status", "--health"]).kind, "unknown");
  });
});

describe("--ask is the one-shot conversation entry", () => {
  /**
   * Until this existed, `runtime.chat` had exactly two callers: the interactive console
   * and the in-process client gateway. There was no way for a script, another program,
   * or an end-to-end test to ask Vesper anything — piping stdin fell through to
   * background daemon mode, which answers nothing.
   */
  it("takes the question as a value, not as another flag", () => {
    const command = parseCli(["--ask", "what is happening?"]);
    assert.equal(command.kind, "ask");
    if (command.kind !== "ask") return;
    assert.equal(command.text, "what is happening?");
    assert.equal(command.json, false);
    assert.equal(command.skipDiscovery, false);
  });

  it("keeps a multi-word question intact when the shell splits it", () => {
    // `--ask get me ready for VRChat` without quotes arrives as separate argv entries.
    // The single-flag rule would otherwise reject it as "extra arguments".
    const command = parseCli(["--ask", "get", "me", "ready", "for", "VRChat"]);
    assert.equal(command.kind, "ask");
    if (command.kind !== "ask") return;
    assert.equal(command.text, "get me ready for VRChat");
  });

  it("carries --json and --skip-discovery without swallowing them into the question", () => {
    const command = parseCli(["--skip-discovery", "--ask", "status", "--json"]);
    assert.equal(command.kind, "ask");
    if (command.kind !== "ask") return;
    assert.equal(command.text, "status", "a modifier flag leaked into the question text");
    assert.equal(command.json, true);
    assert.equal(command.skipDiscovery, true);
  });

  it("refuses an --ask with nothing to ask", () => {
    for (const argv of [["--ask"], ["--ask", "   "], ["--ask", "", ""]]) {
      const command = parseCli(argv);
      assert.equal(command.kind, "unknown", `${JSON.stringify(argv)} was accepted`);
    }
  });

  it("refuses --json on commands that have no turn to serialise", () => {
    assert.equal(parseCli(["--status", "--json"]).kind, "unknown");
    assert.equal(parseCli(["--json"]).kind, "unknown");
  });

  it("still parses every pre-existing command unchanged", () => {
    // Narrowing, not severing: --ask is additive.
    assert.equal(parseCli([]).kind, "repl");
    assert.equal(parseCli(["--doctor"]).kind, "doctor");
    assert.equal(parseCli(["--diagnostics"]).kind, "diagnostics");
    assert.equal(parseCli(["--status"]).kind, "status");
    assert.equal(parseCli(["--client-hello"]).kind, "client-hello");
    assert.equal(parseCli(["--nonsense"]).kind, "unknown");
    assert.equal(parseCli(["--doctor", "--status"]).kind, "unknown");
  });
});
