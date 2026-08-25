# Tools

Built-in tools (all gated):

| Tool | Level |
| --- | --- |
| system_info, process_list, app_detect, context_status, backend_status, knowledge_search, memory_search, optimizer_status, optimizer_analyze, voice_status, diagnostics_report, scheduler_status, mcp_status, fs_list, fs_read | read |
| app_launch, notify, memory_remember, workspace_switch, knowledge_reindex, set_scenario, benchmark_run | safe |
| app_close, memory_forget, knowledge_register, knowledge_remove, optimizer_request, fs_write, runtime_pause, runtime_resume | confirm |
| disk_wipe, credential_extract | never |

The model cannot register a tool that skips this table. Unknown tools are denied.
