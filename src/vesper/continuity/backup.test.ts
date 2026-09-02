import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeyring } from "./crypto.ts";
import { exportState, importState } from "./backup.ts";

describe("backup", () => {
  it("round-trips shared state with integrity", () => {
    const bundle = exportState({
      state: { memories: { gpu: "7900 XT" } },
      sourceDeviceId: "dev_pc",
    });
    const restored = importState(bundle);
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.state, { memories: { gpu: "7900 XT" } });
  });

  it("strips secrets by default", () => {
    const bundle = exportState({
      state: { notes: "ok", api_key: "not-for-export" },
      sourceDeviceId: "dev_pc",
    });
    assert.equal(bundle.includesSecrets, false);
    assert.equal(bundle.state.api_key, "[redacted]");
    assert.equal(bundle.state.notes, "ok");
  });

  it("encrypted backup is unreadable without the key, and tampering fails", () => {
    const ring = createKeyring();
    const bundle = exportState({
      state: { memories: { name: "Wolf" } },
      sourceDeviceId: "dev_pc",
      ring,
    });
    assert.deepEqual(bundle.state, {});
    assert.ok(bundle.envelope);
    const other = createKeyring();
    const wrong = importState(bundle, other);
    assert.equal(wrong.ok, false);
    const right = importState(bundle, ring);
    assert.equal(right.ok, true);
    assert.deepEqual(right.state, { memories: { name: "Wolf" } });
    const tampered = { ...bundle, integrity: { hash: "00".repeat(32) } };
    const failed = importState(tampered, ring);
    assert.equal(failed.ok, false);
  });
});
