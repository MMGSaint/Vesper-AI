/**
 * The thing that actually produces corrections.
 *
 * `corrections.ts` is a store. A store nothing writes to is a schema, and the phase-2
 * checkpoint said as much: the capsule already had a slot for corrections and "nothing
 * yet produces them". This closes that.
 *
 * The loop it closes is the mission's worked example:
 *
 *   Vesper expects a CPU-bound workload and asks the optimizer for a CPU profile.
 *   NEXUS reports the workload is GPU-bound.
 *   The correction records that the expectation was wrong, and what said so.
 *
 * ## What this is careful not to claim
 *
 * **Timing is not causation.** The producer compares an expectation against an
 * observation. It does not assert the optimization caused the observation, and the
 * record has no field in which it could — `evidence` is what was observed and
 * `correction` is the revised belief, neither of which is a causal claim. This mirrors
 * the rule `explain_change` already follows.
 *
 * **An optimization only happened if the adapter said so.** A request that was not
 * accepted produces a correction about the request, never about an effect. Recording
 * "the profile change did not help" when the profile never changed would be inventing
 * both the action and its outcome.
 *
 * **An observation Vesper could not make is not evidence.** When the adapter is
 * unavailable, or reports a bottleneck it could not determine, the outcome is
 * `inconclusive` — a real answer, not a rounding of "we do not know" to "we were right".
 */

import type { CorrectionStore, CorrectionOutcome } from "./corrections.ts";
import type { OptimizerAdapter } from "./specialists/optimizer.ts";
import type { OptimizerTelemetry } from "./types.ts";

type Bound = OptimizerTelemetry["bound"];

/**
 * What Vesper believed when it asked for something, held until an observation arrives.
 *
 * Deliberately small and explicit. A "prediction" with free-form reasoning attached
 * would be chain-of-thought under another name, and the store refuses to keep that.
 */
export interface OptimizerExpectation {
  /** The profile Vesper asked for. */
  profile: string;
  /** The bottleneck Vesper believed it was addressing. */
  expectedBound: Bound;
  /** One sentence on why, for the record's `context`. No reasoning trace. */
  because: string;
  /** True only if the adapter returned accepted:true for the request. */
  accepted: boolean;
  correlationId?: string;
  sessionId?: string;
}

export interface OptimizerCorrectionProducerDeps {
  optimizer: OptimizerAdapter;
  corrections: CorrectionStore;
}

/**
 * Decide what an observation says about an expectation.
 *
 * Split out as a pure function because it is the part worth testing exhaustively, and
 * because a decision table hidden inside an async method that also does I/O is a
 * decision table nobody checks.
 */
export function judgeOptimizerExpectation(input: {
  expectation: OptimizerExpectation;
  observedBound: Bound;
  optimizerAvailable: boolean;
}): { outcome: CorrectionOutcome; correction: string } {
  const { expectation, observedBound, optimizerAvailable } = input;

  if (!optimizerAvailable) {
    return {
      outcome: "inconclusive",
      correction: `The optimizer was unavailable, so nothing confirmed or contradicted the expectation of a ${expectation.expectedBound}-bound workload.`,
    };
  }
  if (!expectation.accepted) {
    return {
      outcome: "inconclusive",
      correction: `The optimizer did not accept the '${expectation.profile}' request, so no profile change happened and its effect cannot be assessed.`,
    };
  }
  if (observedBound === "unknown") {
    return {
      outcome: "inconclusive",
      correction: `The optimizer could not determine the bottleneck, so the expectation of a ${expectation.expectedBound}-bound workload is neither confirmed nor refuted.`,
    };
  }
  if (observedBound === expectation.expectedBound) {
    return {
      outcome: "assumption_held",
      correction: `The workload was ${observedBound}-bound as expected; '${expectation.profile}' addressed the right resource.`,
    };
  }
  return {
    outcome: "assumption_wrong",
    correction: `The workload was ${observedBound}-bound, not ${expectation.expectedBound}-bound; '${expectation.profile}' addressed the wrong resource. Prefer a ${observedBound}-oriented profile for this situation.`,
  };
}

/**
 * Watches optimizer expectations and files a correction when an observation arrives.
 *
 * Expectations are held in memory only. A correction that survives a restart is worth
 * keeping; an expectation waiting for an observation that will now never come is not,
 * and persisting it would produce a store full of `inconclusive` records describing
 * work from before the last reboot.
 */
export class OptimizerCorrectionProducer {
  private readonly deps: OptimizerCorrectionProducerDeps;
  private pending: OptimizerExpectation | null = null;

  constructor(deps: OptimizerCorrectionProducerDeps) {
    this.deps = deps;
  }

  /** Record what Vesper believed when it asked. Replaces any earlier unresolved one. */
  expect(expectation: OptimizerExpectation): void {
    this.pending = expectation;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Ask the optimizer what it now observes, and file a correction against the pending
   * expectation. Returns null when there is nothing to correct.
   *
   * The expectation is cleared whether or not the record is written, so a store that
   * refuses a record (a credential in the evidence, say) cannot leave the producer
   * re-filing the same one on every subsequent observation.
   */
  async observe(): Promise<{ outcome: CorrectionOutcome; recorded: boolean; reason?: string } | null> {
    const expectation = this.pending;
    if (!expectation) return null;
    this.pending = null;

    let observedBound: Bound = "unknown";
    let available = false;
    let evidence = "The optimizer did not answer.";
    try {
      const status = await this.deps.optimizer.getStatus();
      available = status.available;
      if (available) {
        const analysis = await this.deps.optimizer.analyze();
        observedBound = analysis.bound;
        // The specialist's own words, kept as the evidence. Sanitised by the store —
        // this is text from an external system and the rule is that retrieved text is
        // data, never instruction.
        evidence = analysis.summary;
      } else {
        evidence = status.detail;
      }
    } catch (error) {
      // An adapter that throws is an adapter that told us nothing. "Inconclusive" is the
      // honest reading; treating a failed probe as agreement would manufacture evidence.
      available = false;
      evidence = `The optimizer adapter failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    const judged = judgeOptimizerExpectation({ expectation, observedBound, optimizerAvailable: available });
    const written = await this.deps.corrections.record({
      subsystem: "optimizer",
      context: `Asked the optimizer for the '${expectation.profile}' profile because ${expectation.because}`,
      assumption: `The workload was ${expectation.expectedBound}-bound.`,
      evidence,
      correction: judged.correction,
      outcome: judged.outcome,
      source: {
        // The observation came from the optimizer, which is a separate system Vesper
        // does not control. Recorded as external so a reader can weigh it — it confers
        // no authority either way.
        author: "specialist",
        origin: "optimizer",
        external: true,
      },
      correlationId: expectation.correlationId,
      sessionId: expectation.sessionId,
    });

    return written.ok
      ? { outcome: judged.outcome, recorded: true }
      : { outcome: judged.outcome, recorded: false, reason: written.reason };
  }
}
