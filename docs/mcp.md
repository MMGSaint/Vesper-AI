# MCP integration

Vesper speaks the Model Context Protocol over the **stdio** transport: newline-delimited
JSON-RPC 2.0 on a server's stdin and stdout, per the MCP specification. There is no
dependency; the client is in `src/vesper/integrations/mcp.ts`.

MCP is the standard way to attach a specialist Vesper does not implement itself, which
is the architecture the project is built around: Vesper coordinates, specialists stay
specialists.

## Boundaries that must not move

- **A server command comes from config, never from the model.** Nothing the model emits
  can cause a process to launch.
- **Discovered tools go through the normal registry**, so they pass the same permission
  gate as every built-in tool. They default to `confirm`.
- **Tool names are namespaced** as `mcp_<server>_<tool>`. A server must never be able to
  shadow a built-in tool, least of all a never-autonomous one. A server advertising
  `fs_write` registers as `mcp_fake_fs_write` and is gated accordingly.
- **Schemas are narrowed, not forwarded.** Only parameter types Vesper's validator
  understands are kept; anything else is dropped, and a `required` name that is not a
  declared property is filtered out rather than making every call fail.

## Failure behaviour

- A server that cannot be launched is reported, not thrown. A missing binary surfaces
  asynchronously from `spawn`; unhandled, that is an uncaught exception that would take
  the assistant down.
- A silent server times out rather than hanging.
- A server that logs to stdout does not break the session: unparseable lines are
  ignored. Servers are free to log on stderr, which is not protocol traffic.
- A tool-level `isError` is reported as a failure, not returned as a result.

## Status

**IMPLEMENTED + TESTED** against a real stdio server subprocess. No MCP server is
configured by default, and none has been run in production. Vesper remains local-first:
MCP is optional and is never a runtime dependency.
