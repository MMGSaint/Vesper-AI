/**
 * Autonomy Governor.
 *
 * The permission gate answers "may this tool run at this permission level right now?"
 * It is stateless per call. It says nothing about how much of that action has already
 * happened in the last hour, or whether a shape of arguments raises the risk, or
 * whether a per-capability policy tightens what the tier alone would permit.
 *
 * The autonomy governor is the layer that adds those judgments — and it can ONLY
 * tighten decisions. The one-way rule from the synthesis is enforced structurally:
 * the governor's evaluate() returns a PermissionDecision that is either the input
 * decision, or an "allowed: false" derived from it, or an "allowed: false" with
 * requiresConfirmation raised to true. It cannot flip allowed:false → true, cannot
 * relax a `never`, cannot skip a confirmation.
 *
 * Non-goals:
 *   - The governor does not authenticate. Origin trust is settled by the gate and the
 *     decideRemoteToolRequest layer above it; the governor sees the already-authored
 *     origin and can add rules on top.
 *   - The governor does not observe execution results. It records the decision. Result
 *     recording is the audit/decision-journal responsibility.
 *   - The governor does not queue confirmations. That is the confirmation subsystem's
 *     job; the governor only says "this needs confirmation".
 *
 * Load-bearing invariants (each has a named test):
 *   - one-way tightening: no code path in this module produces a decision where allowed
 *     changed from false to true, or requiresConfirmation from true to false
 *   - never-tier immutability: an input decision with level="never" passes through
 *     unchanged (already refused; further tightening is a no-op)
 *   - budget window is a real time window: exceeding it in one burst refuses; refills
 *     as the window rolls forward
 *   - explicit no-op decision path: canObserveNoop() lets a caller record a valid
 *     "nothing to do" as a successful outcome, not silence
 *   - decision journal reaches the event bus so catchup, audit, and future learning
 *     can consume it
 */

import type { EventBus } from "./events.ts";
import type { Logger } from "./logging.ts";
import type {
  JsonObject,
  PermissionDecision,
  ToolSpec,
} from "./types.ts";
import type { RequestOrigin } from "./tools/remote.ts";

/**
 * Six deliberate autonomy levels. Names follow the mission's conceptual policy.
 * INFORM and RECOMMEND are placeholders — future subsystems that emit an event or a
 * recommendation without executing anything can use them; today the governor treats
 * them the same as OBSERVE (no action, decision recorded).
 */
export type AutonomyLevel =
  | "OBSERVE"        // may only look, never act
  | "INFORM"         // may notify the user of a fact
  | "RECOMMEND"      // may suggest an action to the user
  | "PREPARE"        // may plan/queue an action, must be confirmed
  | "AUTO_SAFE"      // may execute an action within a rate budget
  | "AUTO_ADVANCED"  // may execute broader actions, still budgeted
  | "FULL";          // matches the gate's default; no extra tightening

const LEVEL_RANK: Record<AutonomyLevel, number> = {
  OBSERVE: 0,
  INFORM: 1,
  RECOMMEND: 2,
  PREPARE: 3,
  AUTO_SAFE: 4,
  AUTO_ADVANCED: 5,
  FULL: 6,
};

/** Pick the stricter of two levels — mirrors `stricterPermission` on the gate side. */
export function stricterAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[a] < LEVEL_RANK[b] ? a : b;
}

export interface AutonomyBudget {
  /** Regex matched against the tool name. */
  pattern: RegExp;
  /** Max invocations counted inside the rolling window. */
  maxPerWindow: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Optional label shown in the refusal reason. */
  label?: string;
}

export interface ArgumentGate {
  /** Regex matched against the tool name. */
  toolPattern: RegExp;
  /** The tightened level to apply when the args predicate returns true. */
  tightenedTo: AutonomyLevel;
  /** Predicate over the tool arguments. Return true to apply the tightening. */
  when: (args: JsonObject) => boolean;
  /** Reason string appended to the refusal. */
  reason: string;
}

export interface AutonomyPolicy {
  /** The fallback level for any tool with no more-specific rule. */
  default: AutonomyLevel;
  /** Per-tool overrides. Applied on top of `default`; strictest wins. */
  perTool?: Record<string, AutonomyLevel>;
  /** Per-tool-prefix overrides. Applied on top of `default`; strictest wins. */
  perCategory?: Record<string, AutonomyLevel>;
  /** Rate budgets — any matching pattern that has been exhausted refuses the call. */
  budgets?: AutonomyBudget[];
  /** Argument-shape gates. */
  argumentGates?: ArgumentGate[];
}

export interface GovernorInput {
  tool: ToolSpec;
  args: JsonObject;
  origin: RequestOrigin;
  workspaceId: string;
  /** The gate's own decision, already resolved. The governor may only tighten it. */
  gateDecision: PermissionDecision;
  /** Optional correlation id for the decision journal. */
  correlationId?: string;
  /** For tests — the clock the governor should consult for budget windows. */
  now?: () => number;
}

export interface GovernorDecision {
  /**
   * The final PermissionDecision Vesper acts on. If the governor tightened, this is a
   * new object; if it did not, this is the input gateDecision unchanged.
   */
  decision: PermissionDecision;
  /** The autonomy level the governor computed for this call. */
  level: AutonomyLevel;
  /** True when the governor added a refusal or a confirmation the gate did not require. */
  tightened: boolean;
  /** Human-readable reason for the tightening, or empty. */
  tightenReason: string;
}

/**
 * The pure decision function. Kept separate from the class so tests can exercise it
 * without a bus or a clock.
 */
export function evaluateAutonomy(
  input: GovernorInput,
  policy: AutonomyPolicy,
  budgetState: BudgetState,
): GovernorDecision {
  const gateDecision = input.gateDecision;

  // `never` is already refused; anything on top is a no-op.
  if (gateDecision.level === "never") {
    return { decision: gateDecision, level: "OBSERVE", tightened: false, tightenReason: "" };
  }
  // The gate already refused — the governor's role is only to *tighten*, so a refusal
  // passes through unchanged. Recording it stays the caller's responsibility.
  if (!gateDecision.allowed && !gateDecision.requiresConfirmation) {
    return { decision: gateDecision, level: "OBSERVE", tightened: false, tightenReason: "" };
  }

  // Resolve the tool's autonomy level: start from default, then apply category and
  // per-tool overrides; the strictest wins at every step.
  let level: AutonomyLevel = policy.default;
  if (policy.perCategory) {
    for (const [prefix, categoryLevel] of Object.entries(policy.perCategory)) {
      if (input.tool.name.startsWith(prefix)) {
        level = stricterAutonomy(level, categoryLevel);
      }
    }
  }
  if (policy.perTool && policy.perTool[input.tool.name]) {
    level = stricterAutonomy(level, policy.perTool[input.tool.name]);
  }
  // Argument gates can tighten further based on args shape.
  const argMatches: ArgumentGate[] = [];
  if (policy.argumentGates) {
    for (const gate of policy.argumentGates) {
      if (!gate.toolPattern.test(input.tool.name)) continue;
      let matched = false;
      try {
        matched = gate.when(input.args);
      } catch {
        // A predicate that throws should not fail-open. Treat as matched and tighten.
        matched = true;
      }
      if (matched) {
        level = stricterAutonomy(level, gate.tightenedTo);
        argMatches.push(gate);
      }
    }
  }

  // Rate budgets. Every budget whose pattern matches this tool must have headroom.
  const budgetFailures: AutonomyBudget[] = [];
  if (policy.budgets) {
    const now = input.now?.() ?? Date.now();
    for (const budget of policy.budgets) {
      if (!budget.pattern.test(input.tool.name)) continue;
      const count = budgetState.countWithinWindow(budget, now);
      if (count >= budget.maxPerWindow) {
        budgetFailures.push(budget);
      }
    }
  }

  const tightenReasons: string[] = [];
  if (budgetFailures.length) {
    for (const b of budgetFailures) {
      tightenReasons.push(
        `Autonomy budget exhausted for '${b.label ?? b.pattern.source}' (max ${b.maxPerWindow} in ${b.windowMs}ms).`,
      );
    }
  }
  if (argMatches.length) {
    for (const g of argMatches) tightenReasons.push(g.reason);
  }

  // Translate autonomy level into a modification to the gate decision:
  //   OBSERVE / INFORM / RECOMMEND — refuse execution (allowed:false)
  //   PREPARE                       — require confirmation (raise requiresConfirmation)
  //   AUTO_SAFE / AUTO_ADVANCED    — no change unless a budget is exhausted (refuse)
  //   FULL                          — no change ever
  let final: PermissionDecision = gateDecision;
  let tightened = false;

  const refuseFromLevel = level === "OBSERVE" || level === "INFORM" || level === "RECOMMEND";
  if (refuseFromLevel && gateDecision.allowed) {
    final = {
      ...gateDecision,
      allowed: false,
      requiresConfirmation: false,
      reason: `Autonomy '${level}' does not permit executing '${input.tool.name}'.` +
        (tightenReasons.length ? " " + tightenReasons.join(" ") : ""),
    };
    tightened = true;
  } else if (level === "PREPARE" && !gateDecision.requiresConfirmation) {
    final = {
      ...gateDecision,
      allowed: false,
      requiresConfirmation: true,
      reason: `Autonomy 'PREPARE' requires your confirmation for '${input.tool.name}'.` +
        (tightenReasons.length ? " " + tightenReasons.join(" ") : ""),
    };
    tightened = true;
  } else if (budgetFailures.length && gateDecision.allowed) {
    // The gate would allow; budget says no.
    final = {
      ...gateDecision,
      allowed: false,
      requiresConfirmation: false,
      reason: tightenReasons.join(" "),
    };
    tightened = true;
  } else if (argMatches.length && argMatches.some((g) => g.tightenedTo === "PREPARE") && !gateDecision.requiresConfirmation) {
    // An arg gate that raises to PREPARE elevates a would-be-allowed to needs-confirm.
    final = {
      ...gateDecision,
      allowed: false,
      requiresConfirmation: true,
      reason: `Argument-gate tightening for '${input.tool.name}': ${tightenReasons.join(" ")}`,
    };
    tightened = true;
  }

  return {
    decision: final,
    level,
    tightened,
    tightenReason: tightenReasons.join(" "),
  };
}

/**
 * Stateful helper for budget bookkeeping. Kept as a class so a single governor instance
 * carries its own history across many evaluate() calls.
 */
export class BudgetState {
  // Map from budget key (pattern.source + windowMs + maxPerWindow) to a rolling list
  // of timestamps of allowed invocations.
  private windows = new Map<string, number[]>();

  countWithinWindow(budget: AutonomyBudget, now: number): number {
    const key = this.budgetKey(budget);
    const arr = this.windows.get(key);
    if (!arr) return 0;
    const cutoff = now - budget.windowMs;
    // Drop expired entries.
    while (arr.length && arr[0] < cutoff) arr.shift();
    return arr.length;
  }

  record(budget: AutonomyBudget, now: number): void {
    const key = this.budgetKey(budget);
    const arr = this.windows.get(key) ?? [];
    arr.push(now);
    this.windows.set(key, arr);
  }

  private budgetKey(budget: AutonomyBudget): string {
    return `${budget.pattern.source}|${budget.windowMs}|${budget.maxPerWindow}`;
  }
}

export interface AutonomyGovernorOptions {
  policy: AutonomyPolicy;
  events: EventBus;
  log: Logger;
  now?: () => number;
}

export class AutonomyGovernor {
  private policy: AutonomyPolicy;
  private readonly events: EventBus;
  private readonly log: Logger;
  private readonly clock: () => number;
  private budgets = new BudgetState();

  constructor(options: AutonomyGovernorOptions) {
    this.policy = options.policy;
    this.events = options.events;
    this.log = options.log;
    this.clock = options.now ?? (() => Date.now());
  }

  /** Replace the policy. Load-bearing tests must still hold after an update. */
  setPolicy(policy: AutonomyPolicy): void {
    this.policy = policy;
  }

  /** For diagnostics. Never returns the internal windows themselves. */
  status(): { policy: AutonomyPolicy } {
    return { policy: this.policy };
  }

  /**
   * The main entry point. Given the gate's decision, return the final decision this
   * request should be judged by. The governor records the decision on the event bus
   * (retention: durable), so a catchup or an audit can reconstruct why an action was
   * refused, prepared, or allowed.
   */
  evaluate(input: Omit<GovernorInput, "now">): GovernorDecision {
    const now = this.clock();
    const result = evaluateAutonomy(
      { ...input, now: () => now },
      this.policy,
      this.budgets,
    );
    // Only record allowed executions against the budget; a refusal must not consume the
    // budget it just exceeded (otherwise repeated refusals would count as usage).
    if (result.decision.allowed && !result.decision.requiresConfirmation) {
      if (this.policy.budgets) {
        for (const b of this.policy.budgets) {
          if (b.pattern.test(input.tool.name)) this.budgets.record(b, now);
        }
      }
    }
    this.emitDecision(input, result);
    return result;
  }

  /**
   * A meaningful autonomous no-op — Vesper looked and there was nothing to act on. This
   * is a legitimate outcome; the mission's rule "do-nothing must be valid" is the
   * assertion this method makes true. Records the reason on the bus so catchup shows
   * it, but does not touch the budget.
   */
  observeNoop(input: {
    action: string;
    reason: string;
    correlationId?: string;
    workspaceId?: string;
  }): void {
    this.events.emit({
      type: "autonomy.no_action",
      title: `No action required: ${input.action}`,
      detail: input.reason,
      severity: "info",
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
      retention: "durable",
      provenance: { author: "subsystem", source: "autonomy-governor" },
    });
    this.log.info("permission", "autonomy no-op", { action: input.action, reason: input.reason });
  }

  private emitDecision(
    input: Omit<GovernorInput, "now">,
    result: GovernorDecision,
  ): void {
    // The decision is an audit signal — it lands as a `durable` event so the journal
    // keeps it beyond the ring. The event does NOT carry the raw args (they may
    // contain user text or secrets). Callers that need arg detail add it themselves.
    this.events.emit({
      type: "autonomy.decision",
      title: `${input.tool.name} → ${result.decision.allowed ? "allowed" : "refused"}${
        result.decision.requiresConfirmation ? " (confirm)" : ""
      } [${result.level}]`,
      detail: result.tightenReason || result.decision.reason,
      severity: result.decision.allowed ? "info" : "warn",
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
      retention: "durable",
      provenance: {
        author: "subsystem",
        source: "autonomy-governor",
        deviceId: input.origin.deviceId,
      },
      data: {
        tool: input.tool.name,
        gateLevel: input.gateDecision.level,
        gateAllowed: input.gateDecision.allowed,
        gateConfirm: input.gateDecision.requiresConfirmation,
        governorLevel: result.level,
        governorAllowed: result.decision.allowed,
        governorConfirm: result.decision.requiresConfirmation,
        originKind: input.origin.kind,
        tightened: result.tightened,
      } as unknown as JsonObject,
    });
  }
}

/**
 * A conservative default policy: safe reads + workspace switches + notifications run
 * autonomously; fs writes and memory forgets and confirmations still respect the gate
 * (which already asks); anything the gate marks `confirm` stays confirm. No budgets by
 * default — a user can add them via config once the runtime starts driving unattended
 * work.
 */
export function defaultAutonomyPolicy(): AutonomyPolicy {
  return {
    default: "AUTO_SAFE",
    perTool: {
      // Notification-only tools: no action beyond emit.
      notify: "FULL",
      // Reading is always fine.
      fs_read: "FULL",
      fs_list: "FULL",
      system_info: "FULL",
      process_list: "FULL",
      memory_search: "FULL",
      memory_summarize: "FULL",
      knowledge_search: "FULL",
      diagnostics_report: "FULL",
      backend_status: "FULL",
      // Writes and modifications default to the safe tier — the gate already asks for
      // fs_write; the governor does not need to add another layer for it.
      fs_write: "AUTO_SAFE",
      memory_remember: "AUTO_SAFE",
      // App-launch is bounded by the approvedApps list; keep default.
      app_launch: "AUTO_SAFE",
    },
    perCategory: {
      // Any future 'admin.*' tool defaults to PREPARE (require confirm) even if the
      // gate declared it 'safe'.
      "admin.": "PREPARE",
      // Anything security-touching must be PREPARE at minimum.
      "security.": "PREPARE",
    },
    budgets: [],
  };
}
