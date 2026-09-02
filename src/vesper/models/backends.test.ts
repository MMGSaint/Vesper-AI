import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discoverInferenceBackends,
  hintRole,
  isChatModel,
  modelNamesMatch,
  pickInstalledModel,
} from "./backends.ts";

describe("inference backends", () => {
  it("hints roles from model names without claiming benchmarks", () => {
    assert.equal(hintRole("qwen2.5-coder:14b"), "coding");
    assert.equal(hintRole("qwen2.5:3b"), "fast");
    assert.equal(hintRole("qwen2.5:32b"), "large");
  });

  it("refuses embedding models as chat substitutes", () => {
    assert.equal(isChatModel("qwen3:14b"), true);
    assert.equal(isChatModel("nomic-embed-text"), false);
    assert.equal(isChatModel("mxbai-embed-large"), false);
    assert.equal(isChatModel("bge-m3"), false);
  });

  it("treats a missing :latest tag as the same installed model", () => {
    assert.equal(modelNamesMatch("qwen3:14b", "qwen3:14b"), true);
    assert.equal(modelNamesMatch("qwen3:14b:latest", "qwen3:14b"), true);
    assert.equal(modelNamesMatch("qwen3:14b", "qwen2.5:14b"), false);
  });

  it("keeps the configured name when that model is installed", () => {
    assert.equal(
      pickInstalledModel(
        [{ name: "qwen3:14b" }, { name: "nomic-embed-text" }],
        "qwen3:14b",
        "everyday",
      ),
      "qwen3:14b",
    );
    assert.equal(
      pickInstalledModel([{ name: "qwen3:14b:latest" }], "qwen3:14b", "everyday"),
      "qwen3:14b",
      "a :latest listing must not rewrite a matching configured name",
    );
  });

  it("substitutes an installed chat model when the configured name was never pulled", () => {
    assert.equal(
      pickInstalledModel(
        [{ name: "qwen3:14b" }, { name: "qwen2.5-coder:14b" }, { name: "nomic-embed-text" }],
        "qwen2.5:14b",
        "everyday",
      ),
      "qwen3:14b",
    );
    assert.equal(
      pickInstalledModel(
        [{ name: "qwen3:14b" }, { name: "qwen2.5-coder:14b" }],
        "qwen2.5-coder:14b",
        "coding",
      ),
      "qwen2.5-coder:14b",
    );
    assert.equal(
      pickInstalledModel(
        [{ name: "qwen3:14b" }, { name: "qwen2.5-coder:14b" }],
        "missing-coder",
        "coding",
      ),
      "qwen2.5-coder:14b",
    );
  });

  it("does not use an embedding-only install as a chat model", () => {
    assert.equal(
      pickInstalledModel([{ name: "nomic-embed-text" }], "qwen2.5:14b", "everyday"),
      "qwen2.5:14b",
    );
    assert.equal(pickInstalledModel([], "qwen2.5:14b", "everyday"), "qwen2.5:14b");
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
