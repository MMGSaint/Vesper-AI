import assert from "node:assert/strict";
import test from "node:test";
import { CONSOLE_HELP, runConsole, type ConsoleIo, type ConsoleRuntime } from "./console.ts";
import { testRuntime } from "../test-helpers.ts";
import type { AgentTurn } from "../types.ts";

/** Scripted terminal: a queue of typed lines, and everything written captured. */
function scriptedIo(lines: string[]): ConsoleIo & { output: () => string; prompts: string[] } {
  const queue = [...lines];
  const chunks: string[] = [];
  const prompts: string[] = [];
  return {
    prompts,
    async readLine(prompt: string) {
      prompts.push(prompt);
      return queue.length ? (queue.shift() as string) : null;
    },
    write: (text: string) => chunks.push(text),
    writeLine: (text: string) => chunks.push(`${text}\n`),
    output: () => chunks.join(""),
  };
}

function emptyTurn(over: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-1",
    userText: "",
    reply: "",
    epistemic: [],
    toolCalls: [],
    pendingConfirmations: [],
    workspaceId: "general",
    notifications: [],
    events: [],
    at: new Date().toISOString(),
    ...over,
  };
}

function fakeRuntime(over: Partial<ConsoleRuntime> = {}): ConsoleRuntime {
  const store = new Map<string, { id: string; key: string; value: string; category: string }>();
  let currentWorkspace = { id: "general", name: "General", description: "Everyday" };
  let active = "auto";
  return {
    instanceId: "runtime-test",
    chat: async () => emptyTurn(),
    pause: () => {},
    resume: () => {},
    diagnostics: async () => ({ reportText: "DIAGNOSTIC REPORT" }),
    workspaces: {
      current: () => currentWorkspace,
      list: () => [
        { id: "general", name: "General", description: "Everyday" },
        { id: "gaming", name: "Gaming", description: "Games and capture" },
      ],
      switchTo: (idOrName: string) => {
        if (idOrName === "gaming") {
          currentWorkspace = { id: "gaming", name: "Gaming", description: "Games and capture" };
          return currentWorkspace;
        }
        return undefined;
      },
    },
    memory: {
      remember: async (input) => {
        const id = `mem-${store.size + 1}`;
        store.set(id, { id, key: input.key, value: input.value, category: input.category });
        return { id };
      },
      search: async (query: string) =>
        [...store.values()].filter((entry) => entry.value.includes(query)),
      forget: async (id: string) => store.delete(id),
      stats: async () => ({ persistent: store.size, session: 0 }),
    },
    models: {
      status: () => ({
        active,
        available: [
          { id: "ollama", kind: "local", available: false },
          { id: "echo", kind: "test", available: true },
        ],
      }),
      setActive: (id: string) => {
        active = id || "auto";
      },
    },
    background: { state: () => "running" },
    confirmations: new Map(),
    ...over,
  };
}

test("interactive console", async (t) => {
  await t.test("/help lists the commands and /exit stops the loop", async () => {
    const io = scriptedIo(["/help", "/exit"]);
    const reason = await runConsole({ io, runtime: fakeRuntime(), banner: false });
    assert.equal(reason, "exit");
    assert.ok(io.output().includes(CONSOLE_HELP));
  });

  await t.test("end of input stops the loop without an error", async () => {
    const io = scriptedIo([]);
    assert.equal(await runConsole({ io, runtime: fakeRuntime(), banner: false }), "eof");
  });

  await t.test("an unknown command is reported, not silently ignored", async () => {
    const io = scriptedIo(["/nope", "/exit"]);
    await runConsole({ io, runtime: fakeRuntime(), banner: false });
    assert.match(io.output(), /Unknown command: \/nope/);
  });

  await t.test("workspace switching is reachable from the console", async () => {
    const io = scriptedIo(["/workspaces", "/workspace gaming", "/workspace", "/workspace nowhere", "/exit"]);
    await runConsole({ io, runtime: fakeRuntime(), banner: false });
    const out = io.output();
    assert.match(out, /\* general/, "the active workspace is marked");
    assert.match(out, /Switched to Gaming\./);
    assert.match(out, /Gaming \(gaming\)/);
    assert.match(out, /No workspace called "nowhere"/);
  });

  await t.test("memory can be written, searched, and removed from the console", async () => {
    const io = scriptedIo([
      "/remember preference: I stream on Fridays",
      "/memory Fridays",
      "/memory-stats",
      "/forget mem-1",
      "/memory Fridays",
      "/exit",
    ]);
    await runConsole({ io, runtime: fakeRuntime(), banner: false });
    const out = io.output();
    assert.match(out, /Remembered as preference/);
    assert.match(out, /\[preference\] I stream on Fridays/);
    assert.match(out, /persistent=1 session=0/);
    assert.match(out, /Forgot mem-1\./);
    assert.match(out, /No memory matched that\./);
  });

  await t.test("/model refuses an unknown provider and can return to automatic", async () => {
    const io = scriptedIo(["/model nonsense", "/model echo", "/model auto", "/exit"]);
    await runConsole({ io, runtime: fakeRuntime(), banner: false });
    const out = io.output();
    assert.match(out, /No provider called "nonsense"/);
    assert.match(out, /Pinned to echo\./);
    assert.match(out, /automatic again/);
  });

  await t.test("reply text is streamed as it arrives, not buffered to the end", async () => {
    const seen: string[] = [];
    const runtime = fakeRuntime({
      chat: async (_text, options) => {
        options?.onDelta?.("Check");
        seen.push("after-first-delta");
        options?.onDelta?.("ing the host.");
        return emptyTurn({ reply: "Checking the host." });
      },
    });
    const io = scriptedIo(["what's happening?", "/exit"]);
    await runConsole({ io, runtime, banner: false });
    const out = io.output();
    assert.match(out, /Checking the host\./);
    // The streamed text is not printed a second time as the final reply.
    assert.equal(out.match(/Checking the host\./g)?.length, 1);
    assert.deepEqual(seen, ["after-first-delta"]);
  });

  await t.test("a non-streamed reply is still printed", async () => {
    const runtime = fakeRuntime({
      chat: async () => emptyTurn({ reply: "Remembered that." }),
    });
    const io = scriptedIo(["remember this", "/exit"]);
    await runConsole({ io, runtime, banner: false });
    assert.match(io.output(), /Remembered that\./);
  });

  await t.test("Ctrl-C cancels the running turn instead of stopping Vesper", async () => {
    const holder: { interrupt: (() => boolean) | null } = { interrupt: null };
    let sawAbort = false;
    const runtime = fakeRuntime({
      chat: async (_text, options) => {
        // Interrupt arrives while the model is still replying.
        holder.interrupt?.();
        sawAbort = options?.signal?.aborted ?? false;
        return emptyTurn({ reply: "Stopped at your request. Nothing was completed." });
      },
    });
    const io = scriptedIo(["long question", "/exit"]);
    await runConsole({
      io,
      runtime,
      banner: false,
      onInterrupt: (handler) => {
        holder.interrupt = handler;
        return () => {
          holder.interrupt = null;
        };
      },
    });
    assert.equal(sawAbort, true, "the turn receives an aborted signal");
    assert.match(io.output(), /Stopping that reply\./);
  });

  await t.test("Ctrl-C with nothing running is not consumed, so the host can exit", async () => {
    const holder: { interrupt: (() => boolean) | null } = { interrupt: null };
    const io = scriptedIo(["/status", "/exit"]);
    await runConsole({
      io,
      runtime: fakeRuntime(),
      banner: false,
      onInterrupt: (handler) => {
        holder.interrupt = handler;
        return () => {};
      },
    });
    assert.equal(holder.interrupt?.(), false, "no turn in flight means the interrupt is not consumed");
  });

  await t.test("a pending confirmation is surfaced and approval is passed through", async () => {
    const calls: { text: string; confirmId?: string; approve?: boolean }[] = [];
    const runtime = fakeRuntime({
      chat: async (text, options) => {
        calls.push({ text, confirmId: options?.confirmId, approve: options?.approve });
        if (options?.confirmId) {
          return emptyTurn({ reply: `Ran ${options.approve ? "it" : "nothing"}.` });
        }
        return emptyTurn({
          reply: "I need confirmation before I continue.",
          pendingConfirmations: [
            {
              id: "conf-1",
              toolName: "app_close",
              args: { name: "obs64.exe" },
              reason: "Closing an application needs confirmation.",
              workspaceId: "general",
              createdAt: new Date().toISOString(),
            },
          ],
        });
      },
    });
    const io = scriptedIo(["close obs", "y", "/exit"]);
    await runConsole({ io, runtime, banner: false });

    const out = io.output();
    assert.match(out, /Vesper wants to run: app_close/);
    assert.match(out, /reason: Closing an application needs confirmation\./);
    assert.match(out, /obs64\.exe/, "the arguments are shown before approving");
    assert.equal(calls[1]?.confirmId, "conf-1");
    assert.equal(calls[1]?.approve, true);
    assert.match(out, /Ran it\./);
  });

  await t.test("anything other than yes declines the confirmation", async () => {
    for (const answer of ["n", "", "maybe"]) {
      const calls: (boolean | undefined)[] = [];
      const runtime = fakeRuntime({
        chat: async (_text, options) => {
          if (options?.confirmId) {
            calls.push(options.approve);
            return emptyTurn({ reply: "I did not run it." });
          }
          return emptyTurn({
            pendingConfirmations: [
              {
                id: "conf-1",
                toolName: "app_close",
                args: {},
                reason: "needs confirmation",
                workspaceId: "general",
                createdAt: new Date().toISOString(),
              },
            ],
          });
        },
      });
      const io = scriptedIo(["close obs", answer, "/exit"]);
      await runConsole({ io, runtime, banner: false });
      assert.deepEqual(calls, [false], `"${answer}" must not approve`);
    }
  });
});

test("console reaches the real confirm permission tier", async () => {
  // End to end against the real runtime: the CONFIRM tier previously existed in the
  // engine but no interface could reach it.
  const runtime = await testRuntime();
  const first = await runtime.chat("", { confirmId: "missing" });
  assert.match(first.reply, /no longer pending/);

  const record = await runtime.tools.invoke({
    name: "runtime_pause",
    args: {},
    workspaceId: "general",
  });
  assert.equal(record.decision.requiresConfirmation, true, "runtime_pause is a confirm-tier tool");
  assert.equal(record.result, undefined, "it does not run before approval");

  const pending = [...runtime.confirmations.values()].find(
    (item) => item.toolName === "runtime_pause",
  );
  assert.ok(pending, "the confirmation is queued for the interface to surface");

  const io = scriptedIo(["y"]);
  // Drive only the confirmation prompt, exactly as the console does after a turn.
  const approved = await runtime.chat("", { confirmId: pending!.id, approve: true });
  assert.ok(approved.toolCalls.length >= 1);
  assert.equal(approved.toolCalls[0].result?.ok, true, "approval actually runs the tool");
  assert.equal(io.prompts.length, 0);
  await runtime.stop?.();
});
