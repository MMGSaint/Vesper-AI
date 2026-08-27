// Variants of the dangling-symlink write, plus a straight TOCTOU race, plus hardlinks.
import { writeApproved, readApproved } from "../../../../src/vesper/tools/filesystem.ts";
import { readFile, symlink, rm, mkdir, link, writeFile } from "node:fs/promises";

const B = "/home/user/vesper-probes/filesystem-escape/sandbox";
const APPROVED = `${B}/approved`;
const OUT = `${B}/outside`;
const ROOTS = [APPROVED];
const show = async (p: string) => JSON.stringify(await readFile(p, "utf8").catch((e) => `ERR ${e.code}`));

console.log("=== V1: dangling symlink as an INTERMEDIATE directory component ===");
await rm(`${APPROVED}/dlink`, { force: true });
await rm(`${OUT}/newdir`, { recursive: true, force: true });
await symlink(`${OUT}/newdir`, `${APPROVED}/dlink`);
console.log("write <approved>/dlink/x.txt ->", JSON.stringify(await writeApproved(ROOTS, `${APPROVED}/dlink/x.txt`, "V1")));
console.log(" ->", OUT + "/newdir/x.txt =", await show(`${OUT}/newdir/x.txt`));

console.log("\n=== V2: LIVE symlink (target already exists) - control ===");
await rm(`${APPROVED}/live.txt`, { force: true });
await writeFile(`${OUT}/live-target.txt`, "ORIGINAL");
await symlink(`${OUT}/live-target.txt`, `${APPROVED}/live.txt`);
console.log("write <approved>/live.txt ->", JSON.stringify(await writeApproved(ROOTS, `${APPROVED}/live.txt`, "V2")));
console.log(" -> live-target.txt =", await show(`${OUT}/live-target.txt`));

console.log("\n=== V3: dangling symlink chain (link -> link -> outside) ===");
await rm(`${APPROVED}/hop1`, { force: true });
await rm(`${APPROVED}/hop2`, { force: true });
await rm(`${OUT}/hopped.txt`, { force: true });
await symlink(`${APPROVED}/hop2`, `${APPROVED}/hop1`);
await symlink(`${OUT}/hopped.txt`, `${APPROVED}/hop2`);
console.log("write <approved>/hop1 ->", JSON.stringify(await writeApproved(ROOTS, `${APPROVED}/hop1`, "V3")));
console.log(" -> hopped.txt =", await show(`${OUT}/hopped.txt`));

console.log("\n=== V4: dry-run first, then confirm (does dry-run reveal the escape?) ===");
await rm(`${APPROVED}/dry.txt`, { force: true });
await rm(`${OUT}/dry-target.txt`, { force: true });
await symlink(`${OUT}/dry-target.txt`, `${APPROVED}/dry.txt`);
console.log("dryRun ->", JSON.stringify(await writeApproved(ROOTS, `${APPROVED}/dry.txt`, "V4", true)));

console.log("\n=== V5: hardlink inside approved root pointing at an outside file ===");
await rm(`${APPROVED}/hard.txt`, { force: true });
await writeFile(`${OUT}/hard-secret.txt`, "HARDLINK-SECRET");
await link(`${OUT}/hard-secret.txt`, `${APPROVED}/hard.txt`);
console.log("read <approved>/hard.txt ->", JSON.stringify(await readApproved(ROOTS, `${APPROVED}/hard.txt`)));

console.log("\n=== V6: TOCTOU - swap a real file for a symlink between check and write ===");
let won = 0;
for (let i = 0; i < 400; i += 1) {
  const p = `${APPROVED}/race${i}.txt`;
  const t = `${OUT}/race-target-${i}.txt`;
  await rm(p, { force: true });
  await rm(t, { force: true });
  await writeFile(p, "benign");
  const write = writeApproved(ROOTS, p, `RACE-${i}`);
  // swap as fast as possible after the check has started
  await rm(p, { force: true }).catch(() => undefined);
  await symlink(t, p).catch(() => undefined);
  await write;
  const landed = await readFile(t, "utf8").catch(() => null);
  if (landed) { won += 1; console.log(`