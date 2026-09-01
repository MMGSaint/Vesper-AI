import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientUrlFromOllamaHost,
  nativeRoot,
  ollamaEndpointCandidates,
  pickInstalledModel,
} from "./ollama-resolve.ts";

describe("nativeRoot", () => {
  it("strips a trailing slash and a /v1 compat suffix", () => {
    assert.equal(nativeRoot("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
    assert.equal(nativeRoot("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434");
    assert.equal(nativeRoot("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  });
});

describe("ollamaEndpointCandidates", () => {
  it("always includes the configured root, with /v1 stripped", () => {
    const roots = ollamaEndpointCandidates({
      configured: "http://127.0.0.1:11434/v1",
      env: {},
    });
    assert.equal(roots[0], "http://127.0.0.1:11434");
    assert.ok(roots.includes("http://localhost:11434"));
  });

  it("does not add :11434 when the configured endpoint is a custom port", () => {
    const roots = ollamaEndpointCandidates({
      configured: "http://127.0.0.1:54321",
      env: {},
    });
    assert.deepEqual(roots, ["http://127.0.0.1:54321"]);
  });

  it("reads OLLAMA_HOST and rewrites a listen address to a connect address", () => {
    const roots = ollamaEndpointCandidates({
      configured: "http://127.0.0.1:11434",
      env: { OLLAMA_HOST: "0.0.0.0:11434" },
    });
    assert.ok(roots.includes("http://127.0.0.1:11434"));
    assert.equal(
      clientUrlFromOllamaHost("0.0.0.0:11434"),
      "http://127.0.0.1:11434",
    );
  });

  it("refuses a public OLLAMA_HOST unless remote endpoints are allowed", () => {
    const refused = ollamaEndpointCandidates({
      configured: "http://127.0.0.1:54321",
      env: { OLLAMA_HOST: "https://evil.example" },
    });
    assert.deepEqual(refused, ["http://127.0.0.1:54321"]);

    const allowed = ollamaEndpointCandidates({
      configured: "http://127.0.0.1:54321",
      env: { OLLAMA_HOST: "http://10.0.0.9:11434" },
      allowRemote: false,
    });
    // 10/8 is private, so it is allowed without the remote opt-in.
    assert.ok(allowed.includes("http://10.0.0.9:11434"));
  });
});

describe("pickInstalledModel", () => {
  it("keeps the requested name when it is installed", () => {
    assert.equal(
      pickInstalledModel({
        requested: "qwen2.5:14b",
        role: "everyday",
        installed: ["qwen3:14b", "qwen2.5:14b"],
      }),
      "qwen2.5:14b",
    );
  });

  it("does not invent a name when nothing has been probed", () => {
    assert.equal(
      pickInstalledModel({ requested: "qwen2.5:14b", role: "everyday", installed: [] }),
      "qwen2.5:14b",
    );
  });

  it("picks an installed everyday-sized model instead of asking for a missing default", () => {
    // Production defaults name qwen2.5:14b. The target PC has qwen3:14b. Asking for
    // the missing name 404s, the router treats that as an outage, and the user hears
    // the echo stub — "no local inference backend" — with a daemon that is fine.
    assert.equal(
      pickInstalledModel({
        requested: "qwen2.5:14b",
        role: "everyday",
        installed: ["nomic-embed-text", "qwen3:14b"],
      }),
      "qwen3:14b",
    );
  });

  it("does not pick an embedding model as a chat fallback", () => {
    assert.equal(
      pickInstalledModel({
        requested: "qwen2.5:14b",
        role: "everyday",
        installed: ["nomic-embed-text:latest"],
      }),
      "nomic-embed-text:latest",
    );
  });

  it("prefers a coder tag for the coding role", () => {
    assert.equal(
      pickInstalledModel({
        requested: "qwen2.5-coder:14b",
        role: "coding",
        installed: ["qwen3:14b", "qwen2.5-coder:7b"],
      }),
      "qwen2.5-coder:7b",
    );
  });
});
