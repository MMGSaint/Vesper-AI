import assert from "node:assert/strict";
import test from "node:test";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiperTts, createWhisperStt } from "./local-providers.ts";
import { runProcess } from "./process.ts";

/**
 * A stand-in for an installed CLI. Tests run a *real* subprocess so argv handling,
 * stdin, exit codes, and file output are genuinely exercised; only the binary is fake.
 * The script is launched through Node so the same test works on Linux and Windows.
 */
const FAKE_CLI = `
import { writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const tool = argv[0];
const args = argv.slice(1);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (tool === "fake-whisper") {
  if (args.includes("--boom")) {
    process.stderr.write("model failed to load\\n");
    process.exit(3);
  }
  if (args.includes("--hang")) { setTimeout(() => {}, 60_000); }
  else {
    const audio = args[0];
    const outDir = flag("--output_dir");
    const model = flag("--model");
    const language = flag("--language") ?? "auto";
    const bytes = readFileSync(audio).length;
    writeFileSync(
      join(outDir, basename(audio, ".wav") + ".txt"),
      "heard " + bytes + " bytes with " + model + " in " + language + "\\n",
    );
    process.exit(0);
  }
}

if (tool === "fake-piper") {
  if (args.includes("--boom")) {
    process.stderr.write("voice model missing\\n");
    process.exit(4);
  }
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    // Echo the text back verbatim so a test can prove it was never shell-expanded.
    writeFileSync(flag("--output_file"), "RIFF" + stdin);
    process.exit(0);
  });
}
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "vesper-voice-"));
  const script = join(dir, "fake-cli.mjs");
  await writeFile(script, FAKE_CLI, "utf8");
  // Redirect the provider's chosen binary into the fake CLI, keeping every argument
  // the provider built, in order.
  const spawnImpl = ((command: string, args: string[], options: object) =>
    nodeSpawn(process.execPath, [script, command, ...args], options)) as unknown as typeof nodeSpawn;
  return { dir, spawnImpl };
}

test("local voice backends", async (t) => {
  await t.test("whisper turns an audio buffer into text", async () => {
    const { spawnImpl } = await fixture();
    const stt = createWhisperStt({
      binary: "fake-whisper",
      model: "base",
      language: "en",
      spawnImpl,
    });
    const result = await stt.transcribe(new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(result.available, true);
    assert.equal(result.text, "heard 5 bytes with base in en");
    assert.match(result.detail, /No microphone was opened/);
  });

  await t.test("whisper reports an empty buffer instead of running", async () => {
    const { spawnImpl } = await fixture();
    const stt = createWhisperStt({ binary: "fake-whisper", model: "base", spawnImpl });
    const result = await stt.transcribe(new Uint8Array());
    assert.equal(result.available, false);
    assert.match(result.detail, /No audio was supplied/);
  });

  await t.test("a failing whisper run surfaces the backend's own error", async () => {
    const { spawnImpl } = await fixture();
    const stt = createWhisperStt({
      binary: "fake-whisper",
      model: "base",
      extraArgs: ["--boom"],
      spawnImpl,
    });
    const result = await stt.transcribe(new Uint8Array([1]));
    assert.equal(result.available, false);
    assert.match(result.detail, /exited with code 3/);
    assert.match(result.detail, /model failed to load/);
  });

  await t.test("a hung backend is killed and reported, not awaited forever", async () => {
    const { spawnImpl } = await fixture();
    const stt = createWhisperStt({
      binary: "fake-whisper",
      model: "base",
      extraArgs: ["--hang"],
      timeoutMs: 200,
      spawnImpl,
    });
    const result = await stt.transcribe(new Uint8Array([1]));
    assert.equal(result.available, false);
    assert.match(result.detail, /timed out after 200ms/i);
  });

  await t.test("piper turns text into audio bytes", async () => {
    const { spawnImpl } = await fixture();
    const tts = createPiperTts({ binary: "fake-piper", model: "en_US-lessac-medium", spawnImpl });
    const result = await tts.speak("Squad finished updating.");
    assert.equal(result.available, true);
    assert.ok(result.audio && result.audio.length > 0);
    assert.equal(Buffer.from(result.audio!).toString("utf8"), "RIFFSquad finished updating.");
    assert.match(result.detail, /did not open an audio device/);
  });

  await t.test("piper refuses empty text without spawning anything", async () => {
    const { spawnImpl } = await fixture();
    const tts = createPiperTts({ binary: "fake-piper", model: "m", spawnImpl });
    const result = await tts.speak("   ");
    assert.equal(result.available, false);
    assert.match(result.detail, /No text was supplied/);
  });

  await t.test("a failing piper run surfaces the backend's own error", async () => {
    const { spawnImpl } = await fixture();
    const tts = createPiperTts({
      binary: "fake-piper",
      model: "m",
      extraArgs: ["--boom"],
      spawnImpl,
    });
    const result = await tts.speak("hello");
    assert.equal(result.available, false);
    assert.match(result.detail, /exited with code 4/);
    assert.match(result.detail, /voice model missing/);
  });

  await t.test("spoken text is never interpreted by a shell", async () => {
    const { spawnImpl } = await fixture();
    const tts = createPiperTts({ binary: "fake-piper", model: "m", spawnImpl });
    // Every one of these would do something if the text reached a shell.
    const hostile = "$(whoami); rm -rf / && echo `id` | tee /tmp/pwned \"quoted\" 'single'";
    const result = await tts.speak(hostile);
    assert.equal(result.available, true);
    assert.equal(
      Buffer.from(result.audio!).toString("utf8"),
      `RIFF${hostile}`,
      "the text arrives verbatim, unexpanded",
    );
  });
});

test("process runner", async (t) => {
  await t.test("refuses a NUL byte in the command or arguments", async () => {
    const bad = await runProcess({ command: "echo\0evil", args: [] });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /NUL/);

    const badArg = await runProcess({ command: process.execPath, args: ["-e", "1\0"] });
    assert.equal(badArg.ok, false);
    assert.match(badArg.error ?? "", /NUL/);
  });

  await t.test("reports a missing binary rather than throwing", async () => {
    const result = await runProcess({
      command: "definitely-not-installed-vesper-test",
      args: [],
      timeoutMs: 5000,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  await t.test("honours a caller's abort signal", async () => {
    const controller = new AbortController();
    const pending = runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
  });

  await t.test("captures stdout and a non-zero exit code", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.exit(2)"],
      timeoutMs: 10_000,
    });
    assert.equal(result.stdout.toString("utf8"), "out");
    assert.equal(result.code, 2);
    assert.equal(result.ok, false);
  });
});
