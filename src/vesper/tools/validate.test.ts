import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArgs } from "./validate.ts";
import { testRuntime } from "../test-helpers.ts";
import type { ToolParameterSchema } from "../types.ts";

const schema: ToolParameterSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Application name" },
    count: { type: "number" },
    force: { type: "boolean" },
    scenario: { type: "string", enum: ["idle", "gaming", "streaming"] },
    tags: { type: "array" },
  },
  required: ["name"],
};

test("tool argument validation", async (t) => {
  await t.test("accepts well-formed arguments unchanged", () => {
    const result = validateToolArgs(schema, { name: "obs", count: 2, force: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, { name: "obs", count: 2, force: true });
    assert.deepEqual(result.errors, []);
  });

  await t.test("reports a missing required argument", () => {
    const result = validateToolArgs(schema, { count: 1 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("'name' is required")));
  });

  await t.test("enforces the enum it advertises to the model", () => {
    const bad = validateToolArgs(schema, { name: "x", scenario: "meltdown" });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes("must be one of: idle, gaming, streaming")));

    const good = validateToolArgs(schema, { name: "x", scenario: "gaming" });
    assert.equal(good.ok, true);
  });

  await t.test("rejects a value of the wrong type", () => {
    const result = validateToolArgs(schema, { name: 42 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("'name' must be a string (received number)")));
  });

  await t.test("coerces the shapes small local models actually emit", () => {
    // Quoted numbers and booleans are a routine local-model artefact, not an error.
    const result = validateToolArgs(schema, { name: "obs", count: "3", force: "false" });
    assert.equal(result.ok, true);
    assert.equal(result.args.count, 3);
    assert.equal(result.args.force, false);
  });

  await t.test("drops undeclared and prototype keys instead of forwarding them", () => {
    const result = validateToolArgs(schema, {
      name: "obs",
      surprise: "hallucinated",
      __proto__: { polluted: true },
    } as Record<string, unknown> as never);
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, { name: "obs" });
    assert.ok(result.dropped.includes("surprise"));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  await t.test("treats an explicit null for an optional argument as absent", () => {
    const result = validateToolArgs(schema, { name: "obs", count: null });
    assert.equal(result.ok, true);
    assert.equal("count" in result.args, false);
  });

  await t.test("the registry refuses to run a tool with invalid arguments", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "set_scenario",
      args: { scenario: "meltdown" },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
    assert.equal(record.decision.allowed, false);
    assert.match(record.result?.summary ?? "", /must be one of/);
  });

  await t.test("a valid call through the registry still runs", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "set_scenario",
      args: { scenario: "gaming" },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, true);
  });
});
