# Redmine write commands

Real writes are available only when the app is connected in `APP_MODE=redmine` and the backend receives the exact value `REDMINE_WRITE_ENABLED=true`. The default remains read-only. A missing token, invalid configuration, or failed Redmine connection does not enable demo writes.

The server reads the current issue or Version from Redmine before applying a command, checks the selected project, available status transitions, project membership, and configured fields, then verifies the resulting remote state. Local issue and Version caches are updated from Redmine responses; a local-only change is never reported as a successful Redmine write.

The executor supports issue creation and updates, comments, status and Version membership changes, assignee and role changes, Branch and Labels custom fields, due dates, Version creation and editing, release membership, QA handoff, return to the developer, release completion, and newly observed CI automation events. Branch and Labels use the custom-field IDs and choices read from Redmine. Release completion rereads all members, accepts Deploy or the configured successful Done state, moves remaining Deploy issues to Done, then closes the Version. Rejected is not treated as successful completion.

Operations retain their original command and checkpoint each verified remote step. A definite validation or permission response can be retried with the same operation ID; completed steps are verified and skipped, and a persisted created issue or Version ID is reused. An ambiguous POST, comment, or update is recorded as `OUTCOME_UNKNOWN` and cannot be retried automatically. A process restart during an unverified request also blocks the operation for manual inspection. Historical operations without the real-write marker are rejected by the real executor.

Journal editing, deletion, likes, file uploads, watchers, and plugin-only actions remain unavailable unless a capability is explicitly verified. The executor does not imitate these actions in the local cache.

Automated tests use isolated SQLite state and mocked Redmine adapters/transports. They do not contact Redmine or mutate external services.
