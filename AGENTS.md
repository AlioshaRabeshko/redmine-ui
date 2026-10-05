# Project instructions

Respond to the user in Ukrainian. Never respond in Russian.

## Redmine write authorization — 2026-10-05

The user explicitly requested enabling write mode on 2026-10-05. This lifts the previous temporary runtime Redmine write restriction. Implement real Redmine commands behind deliberate backend-only `REDMINE_WRITE_ENABLED=true`; absent/false remains read-only. A flag alone must never turn demo/local-only mutations into pretend real writes. Use actual remote API commands, fresh reads, workflow/permission validation, durable operation status and honest errors. Do not automatically replay historical blocked or uncertain operations.

- During development, automated tests and smoke checks, exercise mutations ONLY against isolated demo fixtures or mocked HTTP transports. Enabling the running app is authorized; do not create/edit/delete real resources merely to test write mode.
- Actual user-initiated actions in the explicitly enabled app may write to Redmine using the backend token. Existing explicitly enabled automation rules may operate on new observed events; do not replay previously blocked historical actions.
- Read-only guards must reject writes before external requests unless explicitly opted in. Real connection failures must never switch to demo.
- Unsupported plugin-only actions (for example journal likes/deletion without a verified API) must remain unavailable and return an honest capability error; never simulate real success in local cache.
- Never mutate Trello or other external services for development/tests. Production database connectors remain read-only.
- Local filesystem, Git commits, SQLite, migrations and isolated demo operations remain authorized.
- Never print or commit `.env`, tokens, authentication headers or secret response fields. Exclude `.env` from Git/Docker context. Only backend accesses the token; do not read/reveal it merely to confirm configuration.

Older references below to the development write restriction describe the historical read-only phase. This authorization supersedes that restriction only for deliberate Redmine runtime write mode, not for tests or unrelated services.

## Implementation

Read RESEARCH.md, REVIEW.md and TECHNICAL.md for product requirements. SQLite + Drizzle ORM + Drizzle Kit and project `.env` are agreed decisions. Use a simple project layout with src/client, src/server, src/shared and drizzle/ migrations; do not build unused abstractions.

The user authorizes development subagents using gpt-6-luna with max reasoning. The primary agent integrates changes and reviews them as needed. Assign distinct file ownership and preserve these instructions in every delegated task.

Maintain an isolated demo mode and a real read-only mode. A failed real connection must not silently become demo mode. UI must clearly display its mode and explain disabled real write actions. Keep drafts when saving is blocked.

For the next UX revision, follow the latest decisions in RESEARCH.md section 19: preserve compact typography; Q toggles the assigned-to-me filter without clearing other filters; S changes status and Cmd/Ctrl+S saves the active form. Settings autosave valid changes, while shortcut edits require explicit save and must remain separate drafts. Mobile UX work and a full mobile audit are deferred by the user; focus on desktop. These decisions do not lift the external mutation restriction.

Issue status and roadmap membership are distinct. Follow the latest audit decisions: only Deploy issues with an active Version display in that release column. Other release issues stay pinned above ordinary cards in their actual status column and share the release color. Moving an issue to Deploy preserves Version membership and displays it in its release column; dropping into a release changes membership only, never the status. Deploy must remain visible even when Redmine marks it is_closed. Completing a release skips tasks already successfully completed in configured Done, checks Deploy for the remaining tasks, then closes them and the Version. Rejected is not automatically equivalent to successful completion. Implement/test mutations only in demo while the restriction is active.

The user resumed implementation on 2026-10-04 for the agreed audit in docs/REAL_READONLY_AUDIT.md and RESEARCH.md sections 19.16–19.24. Activity visibility is configured separately for each project; comments/status/assignee default on, labels/other fields off. Full search defaults to the selected project including completed issues, with an all-accessible-projects option. Keep compact board cards: omit repeated status and branch rows; preserve Branch in details and copy shortcuts. Prefer label/priority pills and distinct avatar frame shapes for roles. Do not treat old audit notes that paused implementation as an ongoing pause.

The user subsequently authorized implementing docs/UX_ROUND2.md and then a full independent desktop UI audit (RESEARCH.md 19.28 and docs/UX_FULL_SCENARIOS.md), using Luna max wherever practical. Local person avatars support photos and emoji with a two-initial fallback; role frames remain project-specific. Activity filters inside an issue autosave the same project-wide preferences. Keep notification read/archive state event-specific when grouping by issue. A compact read-only warning replaces permanent large notices without weakening write guards or losing drafts. The independent audit must search for new problems and report actual scenario coverage, not merely repeat the user's known findings. All external mutation restrictions remain active.

Draft persistence must be reported honestly. If browser storage rejects a write, preserve the scoped draft in the current tab for reopening and warn that reload/tab close can lose it; never show a durable saved indicator solely because a field is dirty. Successful save/cancel must clear the fallback as well as persistent storage without resurrecting stale drafts or discarding text typed during an in-flight save.

The user authorized implementing docs/UX_ROUND3.md on 2026-10-05 using Luna max subagents, then independent validation. Its latest confirmed decisions override earlier discussion-only pauses: the board unread badge opens the issue and scrolls to one unread event; an open issue remains open when it disappears from the unread board filter; comments-only applies to assigned-to-me issues and to visible portions of mixed journals; incoming Activity is buffered behind a “Show new events” action without disturbing drafts/scroll, while unread counters update immediately. Preserve event-specific reads and existing unread history. All external mutation restrictions remain active.

## Database connectors

Production/staging MySQL connectors are read-only: SELECT, SHOW, DESCRIBE only. Never send write statements. Production ClickHouse queries must include a date filter, start with small selective scopes, and use conservative limits. If checking logs without a specified database, use adserver. No production database connector is needed to implement this application.
