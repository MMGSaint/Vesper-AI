import { runProcess } from "../../../../src/vesper/voice/process.ts";
import { defaultDetachedLauncher } from "../../../../src/vesper/windows/process.ts";
import { existsSync, rmSync } from "node:fs";

const marker = "/home/user/vesper-probes/command-execution/PWNED_" + Date.now();
try { rmSync(marker, { force: true }); } catch {}

// 1) runProcess: put injection in command name AND in args, prove no shell chaining.
console.log("=== runProcess with injection as command ===");
const r1 = await runProcess({ command: `sh -c 'touch ${marker}'`, args: [], timeoutMs: 3000 });
console.log("ok=", r1.ok, "error=", r1.error, "marker created?", existsSync(marker));

console.log("=== runProcess: real echo with injection in ARG ===");
const r2 = await runProcess({ command: "echo", args: [`hi; touch ${marker}`, "&&", "touch", marker], timeoutMs: 3000 });
console.log("ok=", r2.ok, "stdout=", JSON.stringify(r2.stdout.toString("utf8")), "marker created?", existsSync(marker));

console.log("=== runProcess: sh -c as command, injection payload in args ===");
const r3 = await runProcess({ command: "/bin/echo", args: [`$(touch ${marker})`, "`touch " + marker + "`"], timeoutMs: 3000 });
console.log("ok=", r3.ok, "stdout=", JSON.stringify(r3.stdout.toString("utf8")), "marker created?", existsSync(marker));

// 2) defaultDetachedLauncher: injection in command name
console.log("=== defaultDetachedLauncher with injection command ===");
const l1 = defaultDetachedLauncher(`sh -c 'touch ${marker}'`, []);
console.log("launch ok=", l1.ok, "pid=", l1.pid, "error=", l1.error);
await new Promise((r) => setTimeout(r, 400));
console.log("marker created?", existsSync(marker));

// 3) defaultDetachedLauncher: legit command, injection in args
console.log("=== defaultDetachedLauncher legit cmd, injection args ===");
const l2 = defaultDetachedLauncher("echo", [`; touch ${marker}`, "&& touch " + marker]);
console.log("launch ok=", l2.ok, "pid=", l2.pid, "error=", l2.error);
await new Promise((r) => setTimeout(r, 400));
console.log("marker created?", existsSync(marker));

try { rmSync(marker, { force: true }); } catch {}
