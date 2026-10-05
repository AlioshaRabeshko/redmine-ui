# Round 4: visible unread Activity events

## Behavior

On an ordinary issue open, an unread notification is acknowledged only after its exact journal's heading and the beginning of every event kind represented by that notification have each remained visible in the active issue dialog for about one second. This lets a long comment be read from its opening while still preventing a visible comment from acknowledging a mixed comment/status/labels event whose other represented parts are hidden by project Activity preferences.

Notifications must belong to the open issue and project, have a known journal ID, and map to a journal rendered by Activity. Read, detail-unavailable, filtered, permalink-forced, or buffered events are excluded. A target opened explicitly from an unread badge/permalink remains on the existing exact-target acknowledgement path. Ordinary opens do not scroll the issue or Activity pane.

The dwell is canceled when the page is hidden or blurred, another modal is on top, the issue/project route changes, the event is no longer eligible, or its required content scrolls out of view. A failed acknowledgement stays unread and is not retried in a render loop; reopening the issue gives it another opportunity. The App callback receives the issue ID and exact notification IDs, and owns current-route/unread revalidation, request deduplication, and cache updates after successful API acknowledgement.

## Implementation and validation

- `visibleUnreadEvents` performs the exact issue/project/journal and complete-event-kind projection checks.
- `useVisibleUnreadEvents` tracks the visible dwell of the journal heading and each represented comment/change-kind anchor, then calls the supplied acknowledgement callback once per ID in the current dialog instance.
- `IssueDialog` marks rendered Activity anchors and excludes its new-event buffer and explicit permalink target.
- Unit coverage: `npx vitest run src/client/features/issues/visibleUnreadEvents.test.ts` passed (4 tests).
- `e2e/round4-visible-events.spec.ts` covers offscreen history, dwell duration, already-read items, mixed hidden kinds, hidden-document cancellation, buffered events, and failed acknowledgement retry after reopen. Its focused run passed 4/4.
- `e2e/round4-drafts.spec.ts` checks that an issue refresh during a held text-save response does not discard newer unsaved description text.
- Final verification on the integrated build: Playwright passed 108/108; the root's Vitest gate passed 243 tests across 42 files.

The browser spec creates demo issues and applies project Activity settings in the isolated demo database; notification and read endpoints are mocked. No live Redmine write or test server was used for this feature work.
