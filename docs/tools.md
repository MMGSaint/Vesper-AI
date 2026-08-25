# Tools

`ToolRegistry` is the only effect channel.

Builtin tools include system_info, process_list, app_launch, app_close, notify, memory_*, workspace_switch, knowledge_search, optimizer_*, set_scenario, plus never-autonomous traps (disk_wipe, credential_extract).

Unknown tools fail closed. Thrown handlers become `could_not_access` results.
