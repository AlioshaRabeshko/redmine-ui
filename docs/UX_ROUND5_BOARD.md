# UX round 5: board and settings

Integration note: the checks below describe this agent’s intermediate handoff, while backend/editor edits were still in progress. The stale orphan-status fixture and temporary parser error were corrected; the integrated build/typecheck and all 300 unit/server tests pass. Final browser/deployment evidence belongs to [UX_ROUND5_RESULTS.md](UX_ROUND5_RESULTS.md).

The board now stores collapsed status and release columns in `collapsedBoardColumns`, keyed by project ID. A collapsed column becomes a narrow vertical title/count rail; its lane remains the drag target, and the same accessible button expands it again. Filter state keeps watcher selection in the shared `watcherId` field, URL state, active chips, and saved views. A project subscription can include the `issue_created` event.

Status drops require the target ID to appear in that issue's `allowedStatusIds`. The backend hydrates this list when Redmine supplies it; a missing permission list leaves status lanes unavailable. Active release lanes remain membership drops and do not change status. Orphaned statuses render in the shared `status:unknown` lane with creation and status drop disabled. User/group assignments stay tagged through `AssigneePicker`; groups use a group glyph and do not resolve through a colliding user ID. If the current assignment is missing from live choices, the picker retains a disabled named option instead of displaying Unassigned.

Urgent and Immediate priorities use filled red pills; Normal remains a light, outlined pill. The high-priority colors are fixed across palettes and define separate light/dark foregrounds for readable contrast. Role avatar frames, unread badge placement, optimistic moves, stale-poll positions, and the separate Backlog list remain in the existing board components.

## Verification

- `npx vitest run src/client/features/board/boardInteractions.test.ts` — passed (4 tests), covering allowed and unknown status drops, release membership drops, and collapse toggling.
- `npx vitest run src/client/features/board/boardInteractions.test.ts src/client/lib/workspaceNavigation.test.ts` — passed (12 tests), including watcher URL parse/serialize coverage.
- `src/shared/domain.test.ts` — 10 of 11 tests pass; the existing test at line 44 still expects an orphan status to map to `status:1`, while the new shared contract returns `status:unknown`. The test expectation needs updating during shared/backend integration.
- `e2e/round5-board.spec.ts` adds isolated demo coverage for watcher URL/saved-view behavior, collapse persistence and orphan lanes, project-keyed collapse settings, colliding group/user IDs, urgent/immediate versus Normal contrast across theme/palette combinations, and the new-issue subscription setting. It was prepared but not run here because the app's `dist` is awaiting the parent integration build.
- `npm run typecheck` could not parse the in-progress backend edit at `src/server/redmine/adapter.ts:443` (`')' expected`). No typecheck result is claimed for this combined workspace; the parent integration run should repeat it after backend edits settle.
