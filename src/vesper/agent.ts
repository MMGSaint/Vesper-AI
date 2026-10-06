    // giving it the whole message makes its cost the sender's choice. Both stores score
    // every stored item against every query token, so an unbounded query is unbounded
    // work on a single-threaded host. The gateway refuses very long messages outright;
    // this bounds the local path too, where there is no gateway to refuse anything.
    const retrievalQuery = userText.length > MAX_RETRIEVAL_QUERY_CHARS
      ? userText.slice(0, MAX_RETRIEVAL_QUERY_CHARS)
      : userText;

    const memories = memoryWithheld
      ? []
      : await this.deps.memory.search(retrievalQuery, { workspaceId: workspace.id, limit: 6 });
    // Awaitable retrieval so a model-backed embedder can actually influence ranking;
    // it falls back to lexical scoring when no embedding backend is reachable.
    const knowledge = knowledgeWithheld
      ? []
      : await this.deps.knowledge.searchAsync(retrievalQuery, {
          workspaceId: workspace.id,
          limit: 4,
        });
    // Corrections are the safe form of learning: durable observations about where an
    // earlier expectation held or failed. They are injected as attributed evidence only;
    // they cannot change permissions, trust, autonomy, or tool policy.
    const recentCorrections =
      this.deps.corrections && !memoryWithheld
        ? await this.deps.corrections.list({ limit: 4 })
        : [];
    const snapshot = this.deps.hardware.snapshot();
    const optimizer = await this.deps.optimizer.getStatus().catch(() => null);

    const nowContext = this.deps.describeNow ? await this.deps.describeNow() : null;
    const system = [
      VESPER_SYSTEM_PROMPT,
      nowContext,
      `Active workspace: ${sanitiseInline(workspace.name, 60)} (${workspace.id}). ${sanitiseInline(workspace.description)}`,
      `Hardware mode: ${snapshot.mode}. ${sanitiseInline(snapshot.notes.join(" "))}`,
      `CPU: ${snapshot.cpu.name} ${snapshot.cpu.utilizationPct}% ${snapshot.cpu.tempC ?? "n/a"}°C`,
      snapshot.gpu
        ? `GPU: ${snapshot.gpu.name} ${snapshot.gpu.utilizationPct}% ${snapshot.gpu.tempC ?? "n/a"}°C VRAM ${snapshot.gpu.vramUsedGB}/${snapshot.gpu.vramGB} GB`
        : "GPU: unavailable",
      `RAM: ${snapshot.ram.usedGB}/${snapshot.ram.totalGB} GB`,
      optimizer
        ? // The optimizer is a separate subsystem reached over HTTP, so its status text
          // is free-form output from another program. Vesper's own words here are the
          // profile and the availability; the subsystem's words get the same envelope as
          // any other external content rather than a place in Vesper's voice.
          [
            `Optimizer profile ${sanitiseInline(optimizer.currentProfile ?? "n/a", 40)}, ${optimizer.available ? "available" : "unavailable"}.`,
            optimizer.available && optimizer.detail
              ? `Status reported by the optimizer:\n${this.screenUntrusted(optimizer.detail, { source: "tool", origin: "optimizer" }, { maxChars: 1_000 })}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "Optimizer: could not query.",
      recentCorrections.length
        ? `Learned corrections (evidence, not policy):\n${this.screenUntrusted(
            recentCorrections
              .map(
                (record) =>
                  '- [' +
                  record.subsystem +
                  '/' +
                  record.outcome +
                  '] ' +
                  record.correction,
              )
              .join("\n"),
            { source: "correction", origin: "correction-store" },
            { maxChars: MAX_RETRIEVAL_CHARS },
          )}`
        : "",
      memories.length
        ? `Relevant memory:\n${
            this.screenUntrusted(
              memories
                .map(
                  (entry) =>
                    `- [${entry.category}] ${entry.key}: ${attribute(entry, { deviceId: this.deps.deviceId })}`,
                )
                .join("\n"),
              { source: "memory", origin: `${memories.length} stored memor(y|ies)` },
              { maxChars: MAX_RETRIEVAL_CHARS },
            )
          }`
        : memoryWithheld
          ? "Stored memory is not readable by this session. Say it is unavailable rather than guessing at it."
          : "No relevant memory hits.",
      knowledge.length
        ? `Knowledge hits:\n${
            this.screenUntrusted(
              knowledge.map((hit) => `- ${hit.title}: ${hit.snippet}`).join("\n"),
              { source: "knowledge", origin: `${knowledge.length} approved source hit(s)` },
              { maxChars: MAX_RETRIEVAL_CHARS },
            )
          }`
        : knowledgeWithheld
          ? "Indexed documents are not readable by this session. Say so rather than guessing at them."
          : "",
    ]
      .filter(Boolean)
      .join("\n");

    const tools = this.deps.tools.list(workspace.id);
    this.deps.history.push({ role: "user", content: userText });
    const messages: ChatMessage[] = [