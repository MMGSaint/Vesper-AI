/**
 * Vesper's interactive console.
 *
 * Extracted from the host entry point so it can be tested without a terminal. The
 * previous inline loop could not surface a pending confirmation, which meant the
 * CONFIRM permission tier existed in the engine but was unreachable from the only
 * interface a user actually has.
 *
 * All I/O is injected. Nothing here decides permissions; it only asks the user and
 * hands the answer back to the runtime.
 */

import type { AgentTurn, MemoryCategory, MemoryEntry, PendingConfirmation } from "../types.ts";
import { MEMORY_CATEGORIES as CATEGORY_LIST } from "../types.ts";
import { VESPER_NAME, VESPER_VERSION } from "../version.ts";

export interface ConsoleIo {
  /** Resolve with the next line, or null when input has ended. */
  readLine: (prompt: string) => Promise<string | null>;
  write: (text: string) => void;
  writeLine: (text: string) => void;
}

export interface ConsoleRuntime {
  instanceId: string;
  chat: (
    text: string,
    options?: {
      confirmId?: string;
      approve?: boolean;
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
    },
  ) => Promise<AgentTurn>;
  pause: () => Promise<void> | void;
  resume: () => Promise<void> | void;
  diagnostics: () => Promise<{ reportText: string }>;
  workspaces: {
    current: () => { id: string; name: string; description?: string };
    list: () => { id: string; name: string; description?: string }[];
    switchTo: (idOrName: string) => { id: string; name: string } | undefined;
  };
  memory: {
    remember: (input: {
      category: MemoryCategory;
      key: string;
      value: string;
      workspaceId?: string;
      source?: MemoryEntry["source"];
    }) => Promise<{ id: string }>;
    search: (
      query: string,
      options?: { workspaceId?: string; limit?: number },
    ) => Promise<{ id: string; key: string; value: string; category: string }[]>;
    forget: (idOrKey: string) => Promise<boolean>;
    stats: () => Promise<{ persistent: number; session: number }>;
  };
  models: { status: () => { active: string; available: { id: string; kind: string; available: boolean }[] }; setActive: (id: string) => void };
  background: { state: () => string };
  confirmations: Map<string, PendingConfirmation>;
}

export interface ConsoleHost {
  doctor: () => Promise<unknown>;
  formatDoctor: (report: never) => string;
}

export const CONSOLE_HELP = `Conversation
  <anything>            Talk to Vesper
  /cancel               Stop the reply in progress (or press Ctrl-C)

Ask Vesper directly (no model needed):
  what can you do?      List tools, backends, workspaces, memory
  what is happening     Runtime snapshot with epistemic tags
  catch me up           Digest of what happened while you were away
  what do you know about me?
                        Summary of stored memories in this workspace

Context
  /workspace            Show the active workspace
  /workspace <name>     Switch workspace
  /workspaces           List configured workspaces

Memory
  /remember <text>      Store a persistent memory
  /memory <query>       Search memory
  /forget <id|key>      Remove a memory
  /memory-stats         Count stored memories

System
  /status               Runtime state in one line
  /models               Show model providers and which is active
  /model <id>           Pin a provider (use "auto" to unpin)
  /diagnostics          Full diagnostics report
  /doctor               Local self-checks
  /pause  /resume       Suspend or resume background work
  /help                 This list
  /exit                 Shut down Vesper`;

const MEMORY_CATEGORIES: ReadonlySet<string> = new Set(CATEGORY_LIST);

function describeToolCalls(turn: AgentTurn): string | null {
  if (!turn.toolCalls.length) return null;
  const parts = turn.toolCalls.map((call) => {
    if (!call.decision.allowed) return `${call.toolName} (denied: ${call.decision.reason})`;
    if (!call.result) return `${call.toolName} (awaiting confirmation)`;
    return call.result.ok ? call.toolName : `${call.toolName} (failed)`;
  });
  return `  · ${parts.join(", ")}`;
}

/**
 * Ask about each queued confirmation in turn. A declined or unanswered prompt leaves
 * the action un-run: silence is never treated as approval.
 */
async function resolveConfirmations(
  turn: AgentTurn,
  io: ConsoleIo,
  runtime: ConsoleRuntime,
): Promise<void> {
  for (const pending of turn.pendingConfirmations) {
    io.writeLine("");
    io.writeLine(`Vesper wants to run: ${pending.toolName}`);
    io.writeLine(`  reason: ${pending.reason}`);
    if (pending.preview) {
      io.writeLine(`  intended: ${pending.preview.summary}`);
      if (pending.preview.affected.length) {
        io.writeLine(`  affected: ${pending.preview.affected.join("; ")}`);
      }
      if (pending.preview.sideEffects.length) {
        io.writeLine(`  side effects: ${pending.preview.sideEffects.join("; ")}`);
      }
      io.writeLine(
        `  reversibility: ${pending.preview.rollbackHint ?? pending.preview.reversibility}`,
      );
    }
    if (pending.args && Object.keys(pending.args).length) {
      io.writeLine(`  arguments: ${JSON.stringify(pending.args)}`);
    }
    const answer = await io.readLine("approve? [y/N] ");
    const approve = answer !== null && /^(y|yes)$/i.test(answer.trim());
    const result = await runtime.chat("", { confirmId: pending.id, approve });
    io.writeLine(result.reply);
  }
}

export interface ConsoleOptions {
  io: ConsoleIo;
  runtime: ConsoleRuntime;
  doctor?: () => Promise<string>;
  /**
   * Registers a Ctrl-C handler and returns a disposer. The handler returns true when
   * it consumed the interrupt by cancelling a turn, so the host can shut down instead
   * when nothing was running.
   */
  onInterrupt?: (handler: () => boolean) => () => void;
  banner?: boolean;
}

/**
 * Run the console until input ends or the user exits.
 * Returns the reason so the caller can decide the exit code.
 */
export async function runConsole(options: ConsoleOptions): Promise<"exit" | "eof"> {
  const { io, runtime } = options;
  let turnAbort: AbortController | null = null;

  const disposeInterrupt = options.onInterrupt?.(() => {
    if (!turnAbort || turnAbort.signal.aborted) return false;
    turnAbort.abort();
    io.writeLine("");
    io.writeLine("Stopping that reply.");
    return true;
  });

  if (options.banner !== false) {
    io.writeLine(`${VESPER_NAME} ${VESPER_VERSION} — ${runtime.instanceId}`);
    io.writeLine(`Workspace: ${runtime.workspaces.current().name}. Type /help for commands.`);
  }

  try {
    for (;;) {
      const line = await io.readLine("vesper> ");
      if (line === null) return "eof";
      const input = line.trim();
      if (!input) continue;

      if (input.startsWith("/")) {
        const [rawCommand, ...rest] = input.split(/\s+/);
        const command = rawCommand.toLowerCase();
        const argument = rest.join(" ").trim();

        if (command === "/exit" || command === "/quit") return "exit";

        const handled = await runCommand(command, argument, io, runtime, options);
        if (handled) continue;

        io.writeLine(`Unknown command: ${command}. Type /help for the list.`);
        continue;
      }

      turnAbort = new AbortController();
      let streamed = "";
      let wroteAny = false;
      try {
        const turn = await runtime.chat(input, {
          signal: turnAbort.signal,
          onDelta: (delta) => {
            if (!wroteAny) {
              io.write("");
              wroteAny = true;
            }
            streamed += delta;
            io.write(delta);
          },
        });

        // Deterministic intents and confirmation prompts never stream, and a cancelled
        // turn appends a notice. Print the reply unless it is exactly what was streamed.
        if (wroteAny) io.writeLine("");
        if (turn.reply && turn.reply !== streamed) io.writeLine(turn.reply);

        const tools = describeToolCalls(turn);
        if (tools) io.writeLine(tools);

        if (turn.pendingConfirmations.length) {
          await resolveConfirmations(turn, io, runtime);
        }

        for (const note of turn.notifications) {
          // Attributed, because a notice the assistant wrote and one Vesper's own
          // machinery emitted read identically otherwise — and the model can write one
          // claiming an action it was just refused actually succeeded.
          const attribution = note.author === "model" ? " (said by the assistant)" : "";
          io.writeLine(`  · ${note.title}${attribution}`);
        }
      } finally {
        turnAbort = null;
      }
    }
  } finally {
    disposeInterrupt?.();
  }
}

async function runCommand(
  command: string,
  argument: string,
  io: ConsoleIo,
  runtime: ConsoleRuntime,
  options: ConsoleOptions,
): Promise<boolean> {
  switch (command) {
    case "/help":
      io.writeLine(CONSOLE_HELP);
      return true;

    case "/cancel":
      io.writeLine("Nothing is running.");
      return true;

    case "/status": {
      const workspace = runtime.workspaces.current();
      io.writeLine(
        `${runtime.background.state()} · workspace=${workspace.id} · model=${runtime.models.status().active} · pending confirmations=${runtime.confirmations.size}`,
      );
      return true;
    }

    case "/pause":
      await runtime.pause();
      io.writeLine("Background work paused.");
      return true;

    case "/resume":
      await runtime.resume();
      io.writeLine("Background work resumed.");
      return true;

    case "/diagnostics": {
      const report = await runtime.diagnostics();
      io.writeLine(report.reportText);
      return true;
    }

    case "/doctor": {
      if (!options.doctor) {
        io.writeLine("Self-checks are not available in this host.");
        return true;
      }
      io.writeLine(await options.doctor());
      return true;
    }

    case "/workspaces": {
      const current = runtime.workspaces.current().id;
      for (const workspace of runtime.workspaces.list()) {
        const marker = workspace.id === current ? "*" : " ";
        io.writeLine(`${marker} ${workspace.id.padEnd(12)} ${workspace.description ?? workspace.name}`);
      }
      return true;
    }

    case "/workspace": {
      if (!argument) {
        const workspace = runtime.workspaces.current();
        io.writeLine(`${workspace.name} (${workspace.id})`);
        return true;
      }
      const next = runtime.workspaces.switchTo(argument);
      io.writeLine(
        next
          ? `Switched to ${next.name}.`
          : `No workspace called "${argument}". Try /workspaces.`,
      );
      return true;
    }

    case "/models": {
      const status = runtime.models.status();
      io.writeLine(`active: ${status.active}`);
      for (const provider of status.available) {
        io.writeLine(
          `  ${provider.available ? "up  " : "down"} ${provider.id.padEnd(14)} ${provider.kind}`,
        );
      }
      return true;
    }

    case "/model": {
      if (!argument) {
        io.writeLine(`active: ${runtime.models.status().active}`);
        return true;
      }
      const target = argument === "auto" ? "" : argument;
      const known = runtime.models.status().available.some((p) => p.id === target);
      if (target && !known) {
        io.writeLine(`No provider called "${argument}". Try /models.`);
        return true;
      }
      runtime.models.setActive(target);
      io.writeLine(target ? `Pinned to ${target}.` : "Provider selection is automatic again.");
      return true;
    }

    case "/remember": {
      if (!argument) {
        io.writeLine("Usage: /remember <text>, or /remember <category>: <text>");
        return true;
      }
      // "preference: dark mode" picks a category; anything else is a plain fact.
      const split = /^([a-z]+):\s*(.+)$/i.exec(argument);
      const tagged = split !== null && MEMORY_CATEGORIES.has(split[1].toLowerCase());
      const category: MemoryCategory = tagged ? (split![1].toLowerCase() as MemoryCategory) : "fact";
      const value = tagged ? split![2] : argument;
      const entry = await runtime.memory.remember({
        category,
        key: value.slice(0, 48),
        value,
        workspaceId: runtime.workspaces.current().id,
        source: "user",
      });
      io.writeLine(`Remembered as ${category} (${entry.id}).`);
      return true;
    }

    case "/memory": {
      if (!argument) {
        io.writeLine("Usage: /memory <query>");
        return true;
      }
      const hits = await runtime.memory.search(argument, {
        workspaceId: runtime.workspaces.current().id,
        limit: 10,
      });
      if (!hits.length) {
        io.writeLine("No memory matched that.");
        return true;
      }
      for (const hit of hits) {
        io.writeLine(`  [${hit.category}] ${hit.value}  (${hit.id})`);
      }
      return true;
    }

    case "/forget": {
      if (!argument) {
        io.writeLine("Usage: /forget <id|key>");
        return true;
      }
      const removed = await runtime.memory.forget(argument);
      io.writeLine(removed ? `Forgot ${argument}.` : `Nothing stored under "${argument}".`);
      return true;
    }

    case "/memory-stats": {
      const stats = await runtime.memory.stats();
      io.writeLine(`persistent=${stats.persistent} session=${stats.session}`);
      return true;
    }

    default:
      return false;
  }
}
