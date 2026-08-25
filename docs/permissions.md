# Permissions

The model cannot override this system.

| Level | Meaning | Examples |
| --- | --- | --- |
| read | Observation only | system_info, process_list, memory_search, optimizer_status |
| safe | Low-risk automation | app_launch (approved), notify, memory_remember, workspace_switch |
| confirm | Needs the user | app_close, memory_forget, optimizer_request |
| never | Refused even if “confirmed” | disk_wipe, credential_extract, security disable, dangerous hardware control |

Policy overrides may only **restrict** further (`safe` → `confirm`), never relax `never`.
