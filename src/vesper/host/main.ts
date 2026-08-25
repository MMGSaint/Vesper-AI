import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createProductionHost } from "./service.ts";

async function main() {
  const host = await createProductionHost({
    production: process.env.VESPER_ENV === "production",
    runtime: { skipDiscovery: process.env.VESPER_SKIP_DISCOVERY === "1" },
  });
  const runtime = host.runtime;
  console.log(`Vesper host started (${runtime.instanceId}). Type a message, /diagnostics, /pause, /resume, or /exit.`);

  const shutdown = async () => {
    await host.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

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
