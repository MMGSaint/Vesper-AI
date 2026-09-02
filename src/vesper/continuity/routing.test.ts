import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectModel, type ModelDescriptor } from "./routing.ts";

const MODELS: ModelDescriptor[] = [
  {
    provider: "ollama",
    model: "qwen3:1.5b",
    capabilities: { tools: true, vision: false, speech: false },
    contextTokens: 8192,
    estimatedMemoryMB: 2000,
    latency: "low",
    quality: "draft",
    location: "local",
    available: true,
    priority: 1,
  },
  {
    provider: "ollama",
    model: "qwen3:14b",
    capabilities: { tools: true, vision: false, speech: false },
    contextTokens: 32768,
    estimatedMemoryMB: 10000,
    latency: "medium",
    quality: "everyday",
    location: "local",
    available: true,
    priority: 5,
  },
  {
    provider: "ollama",
    model: "qwen3:32b",
    capabilities: { tools: true, vision: false, speech: false },
    contextTokens: 32768,
    estimatedMemoryMB: 20000,
    latency: "high",
    quality: "strong",
    location: "local",
    available: true,
    priority: 9,
  },
  {
    provider: "xai-optional",
    model: "grok-4.5",
    capabilities: { tools: true, vision: true, speech: false },
    contextTokens: 128000,
    estimatedMemoryMB: null,
    latency: "medium",
    quality: "strong",
    location: "remote",
    available: true,
    priority: 3,
  },
];

describe("model routing foothold", () => {
  it("usb prefers a lightweight local model", () => {
    const picked = selectModel(MODELS, { tools: true }, "usb");
    assert.equal(picked?.model, "qwen3:1.5b");
  });

  it("desktop prefers the strongest available local model", () => {
    const picked = selectModel(MODELS, { tools: true }, "desktop");
    assert.equal(picked?.model, "qwen3:32b");
  });

  it("capability mismatch prevents invalid selection", () => {
    const picked = selectModel(MODELS, { vision: true, preferLocal: true }, "desktop");
    assert.equal(picked, null);
  });

  it("unavailable models are skipped", () => {
    const unavailable = MODELS.map((item) => ({ ...item, available: item.model === "qwen3:1.5b" }));
    const picked = selectModel(unavailable, { tools: true }, "desktop");
    assert.equal(picked?.model, "qwen3:1.5b");
  });
});
