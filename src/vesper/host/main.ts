import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createProductionHost, formatDoctor } from "./service.ts";
import { CLI_HELP, parseCli } from "../cli.ts";
import { VESPER_NAME, VESPER_VERSION } from "../version.ts";
import { loadHostConfig } from "../config-file.ts";
import { configFile, resolveVesperDirs } from "../paths.ts";

async function main() {
  const command = parseCli(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(CLI_HELP);
    return;
  }
  if (command.kind === "version") {
    console.log(`${VESPER_NAME} ${VESPER_VERSION}`);
    return;
  }
  if (command.kind === "unknown") {
    console.error(command.reason);
    process.exitCode = 1;
    return;
  }
  if (command.kind === "config-check") {
    const loaded = await loadHostConfig(configFile(resolveVesperDirs({ production: process.env.VESPER_ENV === "production" })));
    if (!loaded.ok) {
      console.error(`Config invalid:\n${loaded.errors.join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Config OK (${loaded.source}) at ${loaded.path}`);
    return;
  }

  const skipDiscovery =
    command.kind === "export-memory"
      ? true
      : "skipDiscovery" in command
        ? command.skipDiscovery
        : process.env.VESPER_SKIP_DISCOVERY === "1";
  const host = await createProductionHost({
    production: process.env.VESPER_ENV === "production",
    runtime: { skipDiscovery },
  });
  const runtime = host.runtime;

  const shutdown = async (code = 0) => {
    await host.shutdown();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  if (command.kind === "diagnostics") {
    const report = await runtime.diagnostics();
    console.log(report.reportText);
    await shutdown(0);
    return;
  }
  if (command.kind === "status") {
    const health = runtime.background.health();
    console.log(
      JSON.stringify(
        {
          version: VESPER_VERSION,
          instanceId: runtime.instanceId,
          state: health.state,
          started: runtime.started,
          workspace: runtime.workspaces.current().id,
          pendingConfirmations: runtime.confirmations.size,
          models: runtime.models.status(),
        },
        null,
        2,
      ),
    );
    await shutdown(0);
    return;
  }
  if (command.kind === "health") {
    const path = await host.writeHealth();
    console.log(path);
    await shutdown(0);
    return;
  }
  if (command.kind === "doctor") {
    const report = await host.doctor();
    console.log(formatDoctor(report));
    await shutdown(report.ok ? 0 : 1);
    return;
  }
  if (command.kind === "export-memory") {
    const path = await host.exportMemory();
    console.log(path);
    await shutdown(0);
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
    await shutdown(0);
    return;
  }

  console.log(`Vesper host ${VESPER_VERSION} started (${runtime.instanceId}). Type a message, /diagnostics, /status, /doctor, /pause, /resume, or /exit.`);

  if (!input.isTTY) {
    return;
  }

  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const line = (await rl.question("vesper> ")).trim();
      if (!line) continue;
      if (line === "/exit") break;
      if (line === "/pause") {
        await runtime.pause();
        console.log("paused");
        continue;
      }
      if (line === "/resume") {
        await runtime.resume();
        console.log("resumed");
        continue;
      }
      if (line === "/diagnostics") {
        const report = await runtime.diagnostics();
        console.log(report.reportText);
        continue;
      }
      if (line === "/status") {
        console.log(`${runtime.background.state()} workspace=${runtime.workspaces.current().id} confirms=${runtime.confirmations.size}`);
        continue;
      }
      if (line === "/doctor") {
        console.log(formatDoctor(await host.doctor()));
        continue;
      }
      const turn = await runtime.chat(line);
      console.log(turn.reply);
    }
  } finally {
    rl.close();
    await host.shutdown();
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("host/main.ts") || entry.endsWith("host/main.js") || entry.endsWith("vesper-host.mjs")) {
  void main();
}
