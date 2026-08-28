import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./events.ts";
import {
  AutonomyGovernor,
  BudgetState,
  evaluateAutonomy,
  stricterAutonomy,
  defaultAutonomyPolicy,
  type AutonomyLevel,
  type AutonomyPolicy,
} from "./autonomy.ts";
import type { PermissionDecision, ToolSpec, JsonObject } from "./types.ts";
import type { RequestOrigin } from "./tools/remote.ts";

function silentLog() {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  } as never;
  return log;
}

function tool(name: string, permission: ToolSpec["permission"] = "safe"): ToolSpec {
  return {
    name,
    description: "test",
    permission,
    parameters: { type: "object", properties: {}, required: [] },
  };
}

function decision(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    allowed: true,
    level: "safe",
    requiresConfirmation: false,
    toolName: "test_tool",
    reason: "allowed at safe",
    ...overrides,
  };
}

const localOrigin: RequestOrigin = { kind: "local" };
const remoteOrigin: RequestOrigin = {
  kind: "remote",
  deviceId: "peer",
  
  trust: "trusted",
};

describe("stricterAutonomy — one-way tightening", () => {
  it("always picks the lower-ranked level", () => {
    assert.equal(stricterAutonomy("FULL", "OBSERVE"), "OBSERVE");
    assert.equal(stricterAutonomy("OBSERVE", "FULL"), "OBSERVE");
    assert.equal(stricterAutonomy("PREPARE", "AUTO_SAFE"), "PREPARE");
    assert.equal(stricterAutonomy("AUTO_ADVANCED", "AUTO_SAFE"), "AUTO_SAFE");
  });
});

describe("evaluateAutonomy — pure decision", () => {
  it("passes through a never-tier decision unchanged (already refused)", () => {
    const d = decision({ allowed: false, level: "never", reason: "never" });
    const result = evaluateAutonomy(
      { tool: tool("disk_wipe", "never"), args: {}, origin: localOrigin, workspaceId: "general", gateDecision: d },
      { default: "FULL" },
      new BudgetState(),
    );
    assert.equal(result.decision, d, "governor must not modify a never-tier decision");
    assert.equal(result.tightened, false);
  });

  it("passes through a gate refusal unchanged (only tightens, never relaxes)", () => {
    const d = decision({ allowed: false, level: "safe", reason: "config lockdown" });
    const result = evaluateAutonomy(
      { tool: tool("fs_read"), args: {}, origin: localOrigin, workspaceId: "general", gateDecision: d },
      { default: "FULL" },
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false);
    assert.equal(result.tightened, false, "no tightening beyond the gate's refusal");
  });

  it("OBSERVE refuses execution even when the gate allows", () => {
    // The mission's "The model may REQUEST an action. The governor determines whether
    // Vesper is authorized to perform it." — OBSERVE is the strictest non-refusal.
    const result = evaluateAutonomy(
      {
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      { default: "OBSERVE" },
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false, "OBSERVE must refuse execution");
    assert.equal(result.tightened, true);
    assert.match(result.decision.reason, /OBSERVE/);
  });

  it("PREPARE escalates a would-be-allowed decision to needs-confirm", () => {
    const result = evaluateAutonomy(
      {
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      { default: "PREPARE" },
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.requiresConfirmation, true, "PREPARE must raise requiresConfirmation");
    assert.equal(result.tightened, true);
  });

  it("per-tool override tightens beyond the default", () => {
    const policy: AutonomyPolicy = {
      default: "FULL",
      perTool: { app_launch: "OBSERVE" },
    };
    const result = evaluateAutonomy(
      {
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      policy,
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false);
    assert.equal(result.level, "OBSERVE");
  });

  it("per-category prefix tightens for any matching tool", () => {
    const policy: AutonomyPolicy = {
      default: "FULL",
      perCategory: { "admin.": "PREPARE" },
    };
    const result = evaluateAutonomy(
      {
        tool: tool("admin.rotate_key"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      policy,
      new BudgetState(),
    );
    assert.equal(result.decision.requiresConfirmation, true);
    assert.equal(result.level, "PREPARE");
  });

  it("strictest wins when default + category + per-tool disagree", () => {
    const policy: AutonomyPolicy = {
      default: "FULL",
      perCategory: { "fs_": "AUTO_SAFE" },
      perTool: { fs_write: "OBSERVE" },
    };
    const result = evaluateAutonomy(
      {
        tool: tool("fs_write"),
        args: { path: "/tmp/x" } as JsonObject,
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      policy,
      new BudgetState(),
    );
    assert.equal(result.level, "OBSERVE", "OBSERVE is stricter than AUTO_SAFE, which is stricter than FULL");
  });

  it("argument gate tightens by predicate on args", () => {
    // A tool that's fine in general but sensitive with certain args (e.g. an fs_write
    // to a system path) must be tightenable without banning the tool.
    const policy: AutonomyPolicy = {
      default: "FULL",
      argumentGates: [
        {
          toolPattern: /^fs_write$/,
          tightenedTo: "PREPARE",
          when: (args) => typeof args.path === "string" && args.path.startsWith("/etc"),
          reason: "fs_write to /etc requires explicit confirmation",
        },
      ],
    };
    const allowed = evaluateAutonomy(
      {
        tool: tool("fs_write"),
        args: { path: "/tmp/x" } as JsonObject,
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      policy,
      new BudgetState(),
    );
    assert.equal(allowed.decision.allowed, true, "predicate says no tightening for /tmp");

    const tightened = evaluateAutonomy(
      {
        tool: tool("fs_write"),
        args: { path: "/etc/passwd" } as JsonObject,
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      policy,
      new BudgetState(),
    );
    assert.equal(tightened.decision.requiresConfirmation, true, "predicate says tighten for /etc");
    assert.match(tightened.decision.reason, /\/etc/);
  });

  it("argument gate predicate that throws fails CLOSED (tightens), not open", () => {
    // A predicate throwing is a bug or hostile input. Fail-open would give a hostile
    // input a way to bypass the gate entirely; fail-closed only costs safety in
    // pathological cases.
    const policy: AutonomyPolicy = {
      default: "FULL",
      argumentGates: [
        {
          toolPattern: /^fs_write$/,
          tightenedTo: "OBSERVE",
          when: () => { throw new Error("predicate is broken"); },
          reason: "should not appear",
        },
      ],
    };
    const result = evaluateAutonomy(
      {
        tool: tool("fs_write"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      },
      policy,
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false, "predicate throwing must fail closed");
  });

  it("budget refuses when the window is exhausted, then re-allows after the window rolls", () => {
    const state = new BudgetState();
    const policy: AutonomyPolicy = {
      default: "FULL",
      budgets: [{ pattern: /^app_launch$/, maxPerWindow: 2, windowMs: 60_000, label: "launch cap" }],
    };
    // First two: allowed and recorded.
    let now = 1000;
    for (let i = 0; i < 2; i++) {
      const r = evaluateAutonomy(
        {
          tool: tool("app_launch"),
          args: {},
          origin: localOrigin,
          workspaceId: "general",
          gateDecision: decision(),
          now: () => now,
        },
        policy,
        state,
      );
      assert.equal(r.decision.allowed, true, `call ${i + 1} should be allowed`);
      state.record(policy.budgets![0], now);
    }
    // Third: refused.
    const denied = evaluateAutonomy(
      {
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
        now: () => now,
      },
      policy,
      state,
    );
    assert.equal(denied.decision.allowed, false, "third call must be refused");
    assert.match(denied.decision.reason, /launch cap/);
    // Fast-forward past the window: allowed again.
    now += 60_001;
    const later = evaluateAutonomy(
      {
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
        now: () => now,
      },
      policy,
      state,
    );
    assert.equal(later.decision.allowed, true, "after the window rolls, the budget refills");
  });
});

describe("AutonomyGovernor — end-to-end with the event bus", () => {
  it("records an autonomy.decision event for every evaluate call", async () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({
      policy: { default: "FULL" },
      events,
      log: silentLog(),
    });
    gov.evaluate({
      tool: tool("fs_read", "read"),
      args: {},
      origin: localOrigin,
      workspaceId: "general",
      gateDecision: decision({ level: "read" }),
    });
    const found = events.recent({ type: "autonomy.decision", limit: 5 });
    assert.equal(found.length, 1);
    assert.match(found[0].title, /fs_read/);
    assert.equal(found[0].retention, "durable", "decisions must be journaled");
  });

  it("only records against the budget when the call was actually allowed", () => {
    // A refusal must not consume the budget it just exceeded.
    const events = new EventBus(silentLog());
    let now = 1000;
    const gov = new AutonomyGovernor({
      policy: {
        default: "OBSERVE",
        budgets: [{ pattern: /.*/, maxPerWindow: 5, windowMs: 60_000 }],
      },
      events,
      log: silentLog(),
      now: () => now,
    });
    for (let i = 0; i < 20; i++) {
      const r = gov.evaluate({
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      });
      assert.equal(r.decision.allowed, false, "all OBSERVE-refused");
    }
    // Now switch to FULL; the budget should still have full headroom.
    gov.setPolicy({
      default: "FULL",
      budgets: [{ pattern: /.*/, maxPerWindow: 5, windowMs: 60_000 }],
    });
    for (let i = 0; i < 5; i++) {
      const r = gov.evaluate({
        tool: tool("app_launch"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        gateDecision: decision(),
      });
      assert.equal(r.decision.allowed, true, `call ${i + 1} should be allowed`);
    }
    const sixth = gov.evaluate({
      tool: tool("app_launch"),
      args: {},
      origin: localOrigin,
      workspaceId: "general",
      gateDecision: decision(),
    });
    assert.equal(sixth.decision.allowed, false, "6th call within window must be refused");
  });

  it("observeNoop records a durable event without touching the budget", () => {
    // "Do-nothing must be valid" — the mission's rule that Vesper can observe and
    // decide not to act, and that decision is itself a valid autonomous outcome.
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({
      policy: { default: "FULL" },
      events,
      log: silentLog(),
    });
    gov.observeNoop({
      action: "review pending confirmations",
      reason: "no confirmations were older than the threshold",
      correlationId: "turn-X",
    });
    const found = events.recent({ type: "autonomy.no_action", limit: 5 });
    assert.equal(found.length, 1);
    assert.match(found[0].title, /No action required/);
    assert.equal(found[0].correlationId, "turn-X");
    assert.equal(found[0].retention, "durable");
  });

  it("remote origin is carried into the decision record", () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({
      policy: { default: "FULL" },
      events,
      log: silentLog(),
    });
    gov.evaluate({
      tool: tool("memory_search", "read"),
      args: {},
      origin: remoteOrigin,
      workspaceId: "general",
      gateDecision: decision({ level: "read" }),
    });
    const found = events.recent({ type: "autonomy.decision", limit: 5 });
    assert.equal(found[0].data?.originKind, "remote");
    assert.equal(found[0].provenance?.deviceId, "peer");
  });

  it("defaultAutonomyPolicy keeps reads FULL and admin/security PREPARE", () => {
    // Mission: file-read is AUTO; security policy changes are NEVER (gate handles).
    // The governor's default should not accidentally weaken this.
    const policy = defaultAutonomyPolicy();
    assert.equal(policy.perTool?.fs_read, "FULL");
    assert.equal(policy.perTool?.system_info, "FULL");
    assert.equal(policy.perTool?.memory_search, "FULL");
    assert.equal(policy.perCategory?.["security."], "PREPARE");
    assert.equal(policy.perCategory?.["admin."], "PREPARE");
  });
});

describe("AutonomyGovernor cannot relax — one-way rule", () => {
  it("never produces allowed:true from allowed:false", () => {
    // Fuzz: try every combination of level, initial decision, tool name — the governor
    // must never flip a refusal to an allow.
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({
      policy: {
        default: "FULL",
        perTool: {
          any: "FULL",
        },
      },
      events,
      log: silentLog(),
    });
    for (const startingLevel of ["never", "confirm", "safe", "read"] as const) {
      for (const allowed of [true, false]) {
        for (const confirm of [true, false]) {
          const input = decision({ level: startingLevel, allowed, requiresConfirmation: confirm });
          if (input.allowed) continue; // only checking refusal->allow flipping
          const r = gov.evaluate({
            tool: tool("any", startingLevel),
            args: {},
            origin: localOrigin,
            workspaceId: "general",
            gateDecision: input,
          });
          assert.equal(r.decision.allowed, false, `governor flipped ${startingLevel}/${allowed}/${confirm} to allowed`);
        }
      }
    }
  });

  it("never sets requiresConfirmation:false when the gate set it true", () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({
      policy: { default: "FULL" },
      events,
      log: silentLog(),
    });
    // The gate demanded confirmation. The governor cannot unset it, even at FULL.
    const input = decision({ level: "confirm", allowed: false, requiresConfirmation: true });
    const r = gov.evaluate({
      tool: tool("app_close", "confirm"),
      args: {},
      origin: localOrigin,
      workspaceId: "general",
      gateDecision: input,
    });
    assert.equal(r.decision.requiresConfirmation, true, "cannot un-set confirmation the gate demanded");
    assert.equal(r.decision.allowed, false);
  });
});
