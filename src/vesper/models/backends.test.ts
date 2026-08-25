import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverInferenceBackends, hintRole } from "./backends.ts";

describe("inference backends", () => {
  it("hints roles from model names without claiming benchmarks", () => {
    assert.equal(hintRole("qwen2.5-coder:14b"), "coding");
    assert.equal(hintRole("qwen2.5:3b"), "fast");
    assert.equal(hintRole("qwen2.5:32b"), "large");
  });

  it("discovers backends from probes and does not invent availability", async () => {
    const result = await discoverInferenceBackends({
      endpoints: {
        ollama: "http://127.0.0.1:11434/v1",
        llamacpp: "http://127.0.0.1:8088/v1",
        xai: "https://api.x.ai/v1",
      },
      which: async () => false,
      listModels: async (baseUrl) => {
        if (baseUrl.includes("11434")) {
          return { available: true, models: ["qwen2.5:14b"], detail: "Reached ollama" };
        }
        return { available: false, models: [], detail: "Unreachable" };
      },
    });
    assert.equal(result.backends.find((item) => item.id === "ollama")?.available, true);
    assert.equal(result.backends.find((item) => item.id === "llamacpp")?.available, false);
    assert.equal(result.preferredBackend, "ollama");
    assert.equal(result.models[0]?.name, "qwen2.5:14b");
    assert.equal(result.backends.find((item) => item.id === "llamacpp-rocm")?.available, false);
  });

  it("treats ROCm as opt-in rather than assumed", async () => {
    const result = await discoverInferenceBackends({
      endpoints: {
        ollama: "http://127.0.0.1:11434/v1",
        llamacpp: "http://127.0.0.1:8088/v1",
        xai: "https://api.x.ai/v1",
      },
      env: { VESPER_LLAMA_BACKEND: "rocm" },
      which: async () => false,
      listModels: async () => ({ available: true, models: ["qwen"], detail: "up" }),
    });
    assert.equal(result.backends.find((item) => item.id === "llamacpp-rocm")?.available, true);
    assert.match(result.backends.find((item) => item.id === "llamacpp-rocm")?.detail ?? "", /not assumed faster/i);
  });
});
