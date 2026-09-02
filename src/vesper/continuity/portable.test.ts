import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import {
  assertRelativeSafe,
  isPortableEnv,
  portableLayout,
  resolveNodeDirs,
  resolvePortableDirs,
} from "./portable.ts";
import { resolveVesperDirs } from "../paths.ts";

describe("portable node", () => {
  it("lays out state relative to an arbitrary root", () => {
    const root = join("/media", "usb", "vesper");
    const dirs = portableLayout(root);
    assert.equal(dirs.root, root);
    assert.equal(dirs.data.startsWith(root), true);
    assert.equal(dirs.config.includes("AppData"), false);
    assert.equal(assertRelativeSafe(join(root, "data", "state.json"), root), true);
    assert.equal(assertRelativeSafe("../etc/passwd", root), false);
  });

  it("VESPER_PORTABLE_ROOT wins over LOCALAPPDATA", () => {
    const env = {
      VESPER_PORTABLE_ROOT: "/mnt/stick/vesper",
      LOCALAPPDATA: "C:\\Users\\Other\\AppData\\Local",
      VESPER_ENV: "production",
    };
    assert.equal(isPortableEnv(env), true);
    const resolved = resolvePortableDirs({ env });
    assert.equal(resolved?.root, "/mnt/stick/vesper");
    const dirs = resolveVesperDirs({ env, platform: "win32", production: true });
    assert.equal(dirs.root, "/mnt/stick/vesper");
    assert.equal(dirs.root.includes("AppData"), false);
    const node = resolveNodeDirs({ env, platform: "win32", production: true });
    assert.equal(node.portable, true);
  });
});
