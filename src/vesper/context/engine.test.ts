import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTEXT_SOURCE_IDS, createContextEngine } from "./engine.ts";

describe("context engine", () => {
  it("defaults every source off, including process", () => {
    const engine = createContextEngine({});
    for (const source of engine.sources()) {
      assert.equal(source.enabled, false, `${source.id} must default off`);
    }
    assert.deepEqual(
      engine.sources().map((source) => source.id).sort(),
      [...CONTEXT_SOURCE_IDS].sort(),
    );
  });

  it("does not list processes when the process source is off", async () => {
    let calls = 0;
    const engine = createContextEngine({
      config: { process: false },
      listProcesses: () => {
        calls += 1;
        return [{ name: "VRChat.exe", pid: 1 }];
      },
    });
    const observations = await engine.snapshot();
    assert.equal(calls, 0, "a disabled process source must not call the lister");
    const process = observations.find((item) => item.source === "process");
    assert.equal(process?.kind, "disabled");
  });

  it("invasive sources do no I/O while disabled, even if a spy is installed", async () => {
    let calls = 0;
    const engine = createContextEngine({
      listProcesses: () => {
        calls += 1;
        return [{ name: "obs64.exe" }];
      },
    });
    const observations = await engine.snapshot();
    assert.equal(calls, 0);
    for (const id of ["clipboard", "screen", "browser", "audio", "window", "filesystem"] as const) {
      const item = observations.find((row) => row.source === id);
      assert.equal(item?.kind, "disabled", `${id} must report disabled`);
    }
  });

  it("process observations stay names, not screenshots, when enabled", async () => {
    const engine = createContextEngine({
      config: { process: true },
      listProcesses: () => [{ name: "VRChat.exe", pid: 42 }, { name: "obs64.exe", pid: 7 }],
    });
    const observations = await engine.snapshot();
    const process = observations.find((item) => item.source === "process");
    assert.equal(process?.kind, "observed");
    assert.equal(process?.trust, "system");
    assert.deepEqual(process?.data?.names, ["VRChat.exe", "obs64.exe"]);
    assert.equal(process?.summary.includes("screenshot"), false);
  });

  it("enabling an unimplemented source does not pretend it captured anything", async () => {
    const engine = createContextEngine({ config: { screen: true, clipboard: true } });
    const observations = await engine.snapshot();
    assert.equal(observations.find((item) => item.source === "screen")?.kind, "unavailable");
    assert.equal(observations.find((item) => item.source === "clipboard")?.kind, "unavailable");
    assert.match(observations.find((item) => item.source === "screen")?.summary ?? "", /not implemented/);
    assert.equal(observations.find((item) => item.source === "screen")?.trust, "system");
  });

  it("does not label process observations as user or trusted_local", async () => {
    const engine = createContextEngine({
      config: { process: true },
      listProcesses: () => [{ name: "obs64.exe" }],
    });
    const observations = await engine.snapshot();
    for (const item of observations) {
      assert.equal(item.trust === "user" || item.trust === "trusted_local", false, `${item.source} trust=${item.trust}`);
    }
  });
});
