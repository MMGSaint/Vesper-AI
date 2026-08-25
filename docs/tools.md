# Tools

Every host or optimizer effect goes through the tool registry.

Built-in groups:

- system / process / approved app launch & close
- memory remember / search / forget
- workspace switch
- knowledge search / reindex / register / remove
- optimizer status / analyze / request
- notifications
- diagnostics, backend status, voice status, workload context
- background pause / resume (confirmation-gated from the model)
- simulator scenario (development)
- never: `disk_wipe`, `credential_extract`

Unknown apps cannot be launched. Knowledge roots cannot escape approved directories. High-risk names stay `never` even if confirmation is supplied.
