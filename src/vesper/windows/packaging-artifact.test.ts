import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createZip } from "../../../scripts/zip.mjs";

const REPO = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Read a ZIP back without trusting the writer: walk the End of Central Directory, then
 * each central directory record, and inflate the payloads independently.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "end of central directory not found");

  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50, "central directory header");
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local file header");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(data.length, uncompressedSize, `${name} size mismatch`);
    out.set(name, data);

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

test("package artifact", async (t) => {
  await t.test("the zip writer round-trips content exactly", () => {
    const entries = [
      { name: "a.txt", data: Buffer.from("hello vesper", "utf8") },
      // Highly compressible, so the deflate path is exercised.
      { name: "nested/big.txt", data: Buffer.from("x".repeat(20_000), "utf8") },
      // Incompressible, so the stored path is exercised.
      { name: "nested/tiny.bin", data: Buffer.from([0x00, 0xff, 0x7f]) },
    ];
    const read = readZip(createZip(entries));
    assert.equal(read.size, 3);
    for (const entry of entries) {
      assert.deepEqual(read.get(entry.name), entry.data, `${entry.name} round-trips`);
    }
  });

  await t.test("the same input always produces a byte-identical archive", () => {
    const entries = [{ name: "a.txt", data: Buffer.from("stable", "utf8") }];
    assert.deepEqual(createZip(entries), createZip(entries), "packaging is reproducible");
  });

  await t.test("builds an installable artifact with a manifest and no tests", async () => {
    const out = await mkdtemp(join(tmpdir(), "vesper-pkg-"));
    execFileSync(process.execPath, ["scripts/package.mjs", "--out", out], {
      cwd: REPO,
      stdio: "pipe",
    });

    const produced = await readdir(out);
    const archive = produced.find((name) => name.endsWith(".zip"));
    assert.ok(archive, "an archive is produced");
    assert.ok(produced.some((name) => name.endsWith(".sha256")), "with a checksum beside it");

    const contents = readZip(await readFile(join(out, archive!)));
    const names = [...contents.keys()];

    assert.ok(names.includes("vesper/src/vesper/host/main.ts"), "the runtime entry point ships");
    assert.ok(names.includes("vesper/packaging/windows/install.ps1"), "the installer ships");
    assert.ok(names.includes("vesper/package-lock.json"), "the lockfile ships, so npm ci is reproducible");
    assert.equal(
      names.filter((name) => name.endsWith(".test.ts")).length,
      0,
      "tests are the development contract, not the product",
    );

    const manifest = JSON.parse(contents.get("vesper/PACKAGE.json")!.toString("utf8")) as {
      version: string;
      commit: string;
      note: string;
    };
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.commit.length > 0);
    // The artifact must not imply validation that never happened.
    assert.match(manifest.note, /No Windows command.*was exercised/i);
  });
});
