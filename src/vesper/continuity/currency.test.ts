import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CurrentStateStore, formatCurrent } from "./currency.ts";

describe("current-state memory", () => {
  it("keeps history when a value changes", () => {
    const store = new CurrentStateStore({ now: () => "2026-09-02T00:00:00.000Z" });
    store.remember({
      subject: "sarah.employer",
      value: "X",
      source: "user",
      deviceId: "dev_pc",
      at: "2026-01-01T00:00:00.000Z",
    });
    store.remember({
      subject: "sarah.employer",
      value: "Y",
      source: "user",
      deviceId: "dev_pc",
      at: "2026-09-01T00:00:00.000Z",
    });
    const current = store.current("sarah.employer");
    const history = store.history("sarah.employer");
    assert.equal(current?.value, "Y");
    assert.equal(current?.currency, "current");
    assert.equal(history.some((item) => item.value === "X" && item.currency === "superseded"), true);
    const rendered = formatCurrent(current, history);
    assert.match(rendered, /CURRENT: sarah.employer → Y/);
    assert.match(rendered, /HISTORY: sarah.employer → X \(superseded\)/);
  });

  it("simultaneous disagreement is disputed, not overwritten", () => {
    const store = new CurrentStateStore();
    store.remember({
      subject: "gpu",
      value: "7900 XT",
      source: "user",
      deviceId: "dev_pc",
      at: "2026-09-02T00:00:00.000Z",
    });
    const result = store.mergeRemote({
      id: "fact_other",
      subject: "gpu",
      value: "4060",
      currency: "current",
      source: "user",
      at: "2026-09-02T00:00:00.000Z",
      provenance: { trust: "synced_user_data", deviceId: "dev_laptop" },
      confidence: 1,
    });
    assert.equal(result.disputed, true);
    const history = store.history("gpu");
    assert.equal(history.filter((item) => item.currency === "disputed").length, 2);
    assert.equal(store.current("gpu"), undefined);
  });
});
