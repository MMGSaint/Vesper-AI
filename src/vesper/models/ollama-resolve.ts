/**
 * Where to look for a running Ollama, and which installed model to ask, without
 * assuming one config tree or one loopback spelling is the only one that works.
 *
 * Two facts this exists to keep from collapsing:
 *
 *   1. The packaged launcher sets VESPER_ENV=production and reads %LOCALAPPDATA%\Vesper
 *      (or XDG). Direct `node … host/main.ts` reads `data/vesper`. Those are two files.
 *      A user who configured qwen3:14b in the repo tree and then launched via
 *      vesper-host.cmd was talking to built-in defaults — everyday=qwen2.5:14b,
 *      endpoint=127.0.0.1:11434 — and heard the echo stub. The daemon was fine;
 *      `ollama list` was fine; the launcher was in a different house.
 *
 *   2. Ollama's own client reads OLLAMA_HOST. Vesper did not. On Windows the daemon
 *      often answers `localhost` (IPv6 ::1) while the built-in default is 127.0.0.1.
 *      Those are different sockets. `ollama list` uses one; a hardcoded 127.0.0.1
 *      uses the other.
 *
 * Candidates stay loopback/private unless the user opted into remote endpoints.
 * No machine-specific paths. No invented API. Picking an installed model is a
 * per-turn choice of what to ask, not a config write.
 */

import { checkLocalEndpoint } from "../net.ts";

const DEFAULT_PORT = "11434";

export function nativeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function ollamaEndpointCandidates(input: {
  configured: string;
  env?: NodeJS.ProcessEnv;
  allowRemote?: boolean;
}): string[] {
  const env = input.env ?? process.env;
  const allowRemote = input.allowRemote === true;
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    const root = nativeRoot(raw);
    if (seen.has(root)) return;
    const check = checkLocalEndpoint(`${root}/v1`, {
      allowRemote,
      label: "ollama endpoint",
    });
    if (!check.ok) return;
    seen.add(root);
    out.push(root);
  };

  add(input.configured);

  add(clientUrlFromOllamaHost(env.OLLAMA_HOST));

  // Well-known loopback spellings, only when the configured endpoint is itself the
  // default port. A test (or a user) that pointed Vesper at :0 / a custom port must
  // not have 11434 silently steal the probe.
  if (isDefaultOllamaPort(nativeRoot(input.configured))) {
    add("http://127.0.0.1:11434");
    add("http://localhost:11434");
  }

  return out;
}

/**
 * Turn Ollama's OLLAMA_HOST into a URL a client can actually fetch.
 *
 * `0.0.0.0` and `[::]` are listen addresses, not connect addresses. Connecting to
 * them fails on Windows; map them to 127.0.0.1 so a daemon bound on all interfaces
 * is still reachable without writing a machine-specific path.
 */
export function clientUrlFromOllamaHost(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return rewriteUnspecifiedHost(trimmed);
  }

  return rewriteUnspecifiedHost(`http://${trimmed}`);
}

/**
 * Choose a model this daemon actually has.
 *
 * Returns `requested` unchanged when it is installed, when the tags list is empty
 * (not yet probed — we do not invent), or when nothing installed looks like a chat
 * model. Never writes the choice back to config.
 */
export function pickInstalledModel(input: {
  requested: string;
  role: string;
  installed: readonly string[];
}): string {
  if (input.installed.length === 0) return input.requested;
  if (input.installed.includes(input.requested)) return input.requested;

  const chat = input.installed.filter((name) => !isNonChatModel(name));
  const pool = chat.length > 0 ? chat : [...input.installed];
  const hinted = pool.find((name) => roleHint(name) === input.role);
  return hinted ?? pool[0]!;
}

function isNonChatModel(name: string): boolean {
  return /embed|whisper|clip|caption/i.test(name);
}

function roleHint(name: string): string | null {
  if (/coder|code/i.test(name)) return "coding";
  if (/32b|70b|large/i.test(name)) return "large";
  if (/(?:^|[:\-_])(0\.5b|1b|1\.5b|3b)(?:$|[:\-_])/i.test(name) || /mini|fast/i.test(name)) {
    return "fast";
  }
  if (/14b|7b|8b/i.test(name)) return "everyday";
  return null;
}

function isDefaultOllamaPort(root: string): boolean {
  try {
    const url = new URL(root);
    return url.port === DEFAULT_PORT || url.port === "";
  } catch {
    return false;
  }
}

function rewriteUnspecifiedHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "0.0.0.0" || host === "::" || host === "0000:0000:0000:0000:0000:0000:0000:0000") {
      url.hostname = "127.0.0.1";
    }
    if (!url.port) url.port = DEFAULT_PORT;
    return nativeRoot(url.toString());
  } catch {
    return null;
  }
}
