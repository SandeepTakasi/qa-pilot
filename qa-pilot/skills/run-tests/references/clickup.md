# run-tests under `tracker: clickup`

Read this at step 2 of `/qa-pilot:run-tests` when the profile's tracker is `clickup` (the default).

- Read `testing/<feature>/clickup-map.json` and fetch each mapped task's status over MCP. If ClickUp is unreachable, STOP; never assume approval.
- Write the statuses you fetched to `testing/<feature>/runs/statuses.json` as `{"<CASE-ID>": "<status>"}` and continue with the `case-status.mjs` call in step 2.
- Lifecycle keys (`approved_for_execution`, `approved`, `retest`, `under_review`, `case_review`, `rejected`, `quarantined`) are not status names. This host's names for them live in the profile's `clickup.statuses`; use those when you talk to the user. The script does the matching and returns each executable entry's `state`.
