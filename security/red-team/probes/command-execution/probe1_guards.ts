import { isSafeExecutableName, assertNoShellMeta } from "../../../../src/vesper/security.ts";
import { buildTaskkillCommand, assertApprovedExecutable } from "../../../../src/vesper/windows/process.ts";
import { assertSingleLineArgument } from "../../../../src/vesper/windows/exec.ts";

const payloads = [
  "notepad.exe & calc.exe",
  "notepad.exe && calc.exe",
  "notepad.exe; calc.exe",
  "notepad.exe | calc.exe",
  "$(calc.exe)",
  "`calc.exe`",
  "notepad.exe\ncalc.exe",
  "notepad.exe\rcalc.exe",
  "notepad.exe > out.txt",
  "notepad.exe < in.txt",
  "..\\..\\windows\\system32\\calc.exe",
  "../../bin/sh",
  "/bin/sh",
  "C:\\Windows\\System32\\cmd.exe",
  "cmd.exe /c calc",
  "powershell -c calc",
  "app name with space.exe",
  "app%COMPUTERNAME%.exe",
  "app\u0000.exe",
  "app\u202Eexe",  // unicode RTL override
  "app\u3000name.exe", // ideographic space
  "café.exe",
];

console.log("=== isSafeExecutableName ===");
for (const p of payloads) {
  console.log(JSON.stringify(p), "=>", isSafeExecutableName(p));
}

console.log("\n=== buildTaskkillCommand (app_close deterministic path) ===");
for (const p of payloads) {
  try {
    const cmd = buildTaskkillCommand(p);
    console.log("ACCEPTED", JSON.stringify(p), "=> argv", JSON.stringify([cmd.command, ...cmd.args]));
  } catch (e) {
    console.log("REJECTED", JSON.stringify(p), "=>", (e as Error).message);
  }
}

console.log("\n=== assertApprovedExecutable ===");
for (const p of payloads) {
  try { assertApprovedExecutable(p); console.log("ACCEPTED", JSON.stringify(p)); }
  catch (e) { console.log("REJECTED", JSON.stringify(p), (e as Error).message); }
}
