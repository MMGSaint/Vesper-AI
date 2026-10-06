import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenWakeWordDetector, findPythonCommand } from "./openwakeword.ts";

describe("openWakeWord adapter", () => {
  it("requires an explicit local model and Python runtime", () => {
    const missingModel = createOpenWakeWordDetector({
      platform: "win32",
      pythonCommand: "python",
    });
    assert.equal(missingModel.available(), false);
    assert.equal(missingModel.status().backend, "none");

    const ready = createOpenWakeWordDetector({
      platform: "win32",
      modelPath: "C:\\\\Vesper\\\\models\\\\wake.onnx",
      pythonCommand: "python",
    });
    assert.equal(ready.available(), true);
    assert.equal(ready.status().backend, "openwakeword");
  });

  it("refuses unsafe model paths", () => {
    const detector = createOpenWakeWordDetector({
      platform: "win32",
      modelPath: "C:\\\\bad\\nmodel.onnx",
      pythonCommand: "python",
    });
    assert.equal(detector.available(), false);
  });

  it("finds the first available Python command", async () => {
    const calls: string[] = [];
    const found = await findPythonCommand(
      async (name) => {
        calls.push(name);
        return name === "py";
      },
      ["python", "py"],
    );
    assert.equal(found, "py");
    assert.deepEqual(calls, ["python", "py"]);
  });
});
