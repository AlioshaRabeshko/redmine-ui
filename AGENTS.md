# Project instructions

Respond to the user in Ukrainian. Never respond in Russian.

## Development restriction: no external mutations

The user explicitly prohibits ALL mutating operations against Redmine during development and testing, even when a real API token is present in the project `.env`. This is a TEMPORARY DEVELOPMENT RESTRICTION, not a permanent limitation of the intended product. The user clarified that writes should be enableable later, after validation and explicit authorization. Until then this restriction remains active.

- Never create, edit, delete, assign, transition, watch/unwatch, comment, upload attachments, or change issues, Versions / NEXT, projects, custom fields, or any other Redmine resource during development or tests.
- Never mutate Trello or other external services for development or tests.
- Real Redmine requests are read-only: GET / HEAD only. Enforce this in the transport as well as in the real adapter. Real write commands must return a clear read-only error BEFORE any external request. Do not add an environment variable or UI toggle that bypasses this restriction.
- Keep command/capability boundaries ready for a future explicitly authorized write mode. Once the user lifts the restriction, add deliberate opt-in write configuration with a safe read-only default; retain demo tests and authorization/error handling. Do not enable or exercise that future mode during this development/testing run. UI copy must describe the current block as temporary.
- Background automations may read and calculate intended actions; they must not write to Redmine. Report blocked actions honestly and avoid repeated attempts.
- Exercise editing, creation, transitions, comments, releases and automation execution only against isolated demo fixtures or mocked transports. Tests must verify that real transport write methods cannot be sent.
- Local filesystem, Git commits, local application SQLite writes, migrations and isolated demo operations are authorized and are not external mutations.
- Never print or commit `.env`, tokens, authentication headers, or secret fields from API responses. Exclude `.env` from Git and Docker build context. Only the backend may access the token.
- Do not read or reveal the token just to confirm it exists. Check configured status without displaying the value.

## Implementation

Read RESEARCH.md, REVIEW.md and TECHNICAL.md for product requirements. SQLite + Drizzle ORM + Drizzle Kit and project `.env` are agreed decisions. Use a simple project layout with src/client, src/server, src/shared and drizzle/ migrations; do not build unused abstractions.

The user authorizes development subagents using gpt-6-luna with max reasoning. The primary agent integrates changes and reviews them as needed. Assign distinct file ownership and preserve these instructions in every delegated task.

Maintain an isolated demo mode and a real read-only mode. A failed real connection must not silently become demo mode. UI must clearly display its mode and explain disabled real write actions. Keep drafts when saving is blocked.

For the next UX revision, follow the latest decisions in RESEARCH.md section 19: preserve compact typography; Q toggles the assigned-to-me filter without clearing other filters; S changes status and Cmd/Ctrl+S saves the active form. Settings autosave valid changes, while shortcut edits require explicit save and must remain separate drafts. Mobile UX work and a full mobile audit are deferred by the user; focus on desktop. These decisions do not lift the external mutation restriction.

Issue status and roadmap membership are distinct. Follow the latest audit decisions: only Deploy issues with an active Version display in that release column. Other release issues stay pinned above ordinary cards in their actual status column and share the release color. Moving an issue to Deploy preserves Version membership and displays it in its release column; dropping into a release changes membership only, never the status. Deploy must remain visible even when Redmine marks it is_closed. Completing a release skips tasks already successfully completed in configured Done, checks Deploy for the remaining tasks, then closes them and the Version. Rejected is not automatically equivalent to successful completion. Implement/test mutations only in demo while the restriction is active.

The user resumed implementation on 2026-10-04 for the agreed audit in docs/REAL_READONLY_AUDIT.md and RESEARCH.md sections 19.16–19.24. Activity visibility is configured separately for each project; comments/status/assignee default on, labels/other fields off. Full search defaults to the selected project including completed issues, with an all-accessible-projects option. Keep compact board cards: omit repeated status and branch rows; preserve Branch in details and copy shortcuts. Prefer label/priority pills and distinct avatar frame shapes for roles. Do not treat old audit notes that paused implementation as an ongoing pause.

## Database connectors

Production/staging MySQL connectors are read-only: SELECT, SHOW, DESCRIBE only. Never send write statements. Production ClickHouse queries must include a date filter, start with small selective scopes, and use conservative limits. If checking logs without a specified database, use adserver. No production database connector is needed to implement this application.
