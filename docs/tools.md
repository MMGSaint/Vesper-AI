# Tools

Built-in tools (all gated):

| Tool | Level |
| --- | --- |
| system_info, process_list, app_detect, context_status, backend_status, knowledge_search, memory_search, optimizer_status, optimizer_analyze, voice_status, diagnostics_report, scheduler_status, mcp_status, fs_list, fs_read, events_recent, explain_change, governor_decisions, corrections_list | read |
| app_launch, notify, memory_remember, workspace_switch, knowledge_reindex, set_scenario, benchmark_run | safe |
| app_close, memory_forget, knowledge_register, knowledge_remove, optimizer_request, fs_write, runtime_pause, runtime_resume | confirm |
| disk_wipe, credential_extract | never |

The model cannot register a tool that skips this table. Unknown tools are denied.

## Scheduled work

`task_create` (safe) queues work. With `tool` it is a `tool_call` that runs unattended
through the same permission chain, origin `scheduled`. With `dueAt` (ISO-8601) or
`inSeconds` and no tool it is a `reminder`: a notification when due, never a tool —
even if the persisted args name one. `dueAt` also delays a `tool_call`. A description-only
task with neither a tool nor a due time is still a note the scheduler will not start.

Reminders and delayed tool calls fire from the idle tick. That tick is off until
`agent.driveTasksOnIdle` is true — a first-boot policy decision, not a missing
executor. See `docs/first-pc-boot.md` step 12.
