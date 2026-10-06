  if (command.kind === "decisions") {
    const report = await collectDecisions({
      events: runtime.events,
      journal: runtime.journal,
      governor: runtime.autonomy,
    });
    console.log(formatDecisions(report));
    await shutdown(0, "decisions");
    return;
  }
  if (command.kind === "export-memory") {
    const path = await host.exportMemory();
    console.log(path);
    await shutdown(0, "export-memory");
    return;
  }
  if (command.kind === "ask") {
    const turn = await runtime.chat(command.text);

    // A pending confirmation is reported, never answered here.
    //
    // `--ask` is one question from a script, and a script cannot be the person the
    // confirmation is asking. Auto-approving would make a convenience flag into a way to
    // run confirm-tier tools unattended, which is the "confirmation is not authorization"
    // rule read backwards. The exit code says a human is needed; the action stays queued
    // for the console.
    const waiting = turn.pendingConfirmations;

    if (command.json) {
      console.log(
        JSON.stringify(
          {
            reply: turn.reply,
            epistemic: turn.epistemic,
            workspaceId: turn.workspaceId,
            toolCalls: turn.toolCalls.map((call) => ({
              tool: call.toolName,
              allowed: call.decision.allowed,
              level: call.decision.level,
              requiresConfirmation: call.decision.requiresConfirmation,
              ok: call.result?.ok ?? null,
              epistemic: call.result?.epistemic ?? null,
              summary: call.result?.summary ?? null,
            })),
            pendingConfirmations: waiting.map((pending) => ({
              id: pending.id,
              tool: pending.toolName,
              reason: pending.reason,
              preview: pending.preview ?? null,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(turn.reply);
      for (const pending of waiting) {
        console.error(`Waiting for your confirmation: ${pending.toolName} — ${pending.reason}`);
      }
    }

    await shutdown(waiting.length > 0 ? 3 : 0, "ask");
    return;
  }

  if (command.kind === "voice-once") {
    const result = await runtime.voiceOnce();
    console.log(JSON.stringify(result, null, 2));
    await shutdown(result.ok ? 0 : 2, "voice-once");
    return;
  }

  if (command.kind === "client-hello") {
    console.log(
      JSON.stringify(
        {
          ...host.gateway.hello(),
          transport: "in-process",
          forbidden: host.gateway.forbiddenPowers(),
          note: "No network listener. Tokens are issued by the host, not by this command.",
        },
        null,
        2,
      ),
    );
    await shutdown(0, "client-hello");
    return;
  }

  if (command.kind === "first-boot-report") {
    // The report is produced by the background discovery pass that starts on
    // `runtime.start()`. Waiting on it here is what turns "the discovery happened, and
    // its result is written to a file somewhere" into "the discovery result is on your
    // terminal, now." Exit 0 when the report exists, exit 4 when discovery failed and
    // left the report null, per the pattern for one-shot commands with two outcomes.
    const report = await runtime.waitForFirstBoot();
    if (report) {
      console.log(report.reportText);
      await shutdown(0, "first-boot-report");
    } else {
      console.error("First-boot discovery did not produce a report (see logs).");
      await shutdown(4, "first-boot-report-failed");
    }
    return;
  }

  if (!input.isTTY) {
    await runBackground(host, shutdown);
    return;
  }

  const rl = createInterface({ input, output });
  let sigintHandler: (() => boolean) | null = null;
  const onSigint = () => {
    // Ctrl-C cancels the reply in progress; it only stops Vesper when nothing is running.
    if (sigintHandler?.()) return;
    void shutdown(0, "SIGINT");