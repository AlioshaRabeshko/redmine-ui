# UX Round 4 independent QA

QA ran only against the Playwright-configured demo service (`APP_MODE=demo`, empty Redmine token, `REDMINE_WRITE_ENABLED=false`, temporary SQLite under the system temp directory). No real Redmine or Trello mutations were made. The full suite/build remain owned by root.

## Source review

`moveIssue` retains the optimistic issue and pending lock when the command outcome is uncertain and its immediate detail read also fails. The initial review found that a later failed detail read could leave the issue locked indefinitely; this was reported to the App owner. The current source now retries transient read failures with a capped backoff, while inaccessible issues clear the optimistic state and lock. This source change was reviewed, but the focused browser run below does not simulate repeated detail-read failures.

The quick To Do action removes its backlog row from the optimistic `BoardData` as soon as status changes. A focused action button would previously unmount and drop keyboard focus. The backlog now moves focus to the next row, then the previous row, or the board focus fallback before starting the move. The browser test confirms focus moves to the adjacent row after the quick action.

## Browser checks

The first default-sandbox invocation could not bind `127.0.0.1:3100` (`listen EPERM`). Escalated runs used the isolated demo Playwright configuration, with empty Redmine token, writes disabled, and temporary SQLite; the port was free after the final run.

| Command | Result |
| --- | --- |
| `npm run test:e2e -- e2e/round4-backlog.spec.ts e2e/round4-independent.spec.ts` | 3/4 passed. The screenshot matrix and mixed unread dwell scenario passed; quick To Do/S/Cmd+C passed. The backlog test then hit a test-harness closure error in `evaluateAll`; fixed by passing expected IDs as the browser callback argument. |
| `npm run test:e2e -- e2e/round4-backlog.spec.ts` | 1/2 passed. Quick To Do/S/Cmd+C passed. The read-only/search scenario timed out because the full-search popup intercepted the filter button; the test now closes that popup with Escape before clicking the toolbar. |
| `npm run test:e2e -- e2e/round4-backlog.spec.ts e2e/round4-independent.spec.ts` | 4/4 passed after the harness fixes: backlog/read-only and filter behavior; quick To Do with release membership and keyboard focus; the screenshot matrix; and mixed unread comment/status visibility. |

The final 4/4 run used the footer-only reserved width. Its screenshots show the unread badge sharing the card footer row to the right of the avatars; the 123-count badge does not overlap the due chip. Backlog screenshots at both widths show the long unbroken title and label wrapping within their rows, with no document or list horizontal overflow. The light/dark variants retain readable contrast, and the title/priority row keeps its original width.

The screenshot matrix is one Playwright case that writes eight images (board and backlog at 1280 and 1600, in light and dark themes) under `test-results/round4-independent/`. The mixed unread test verifies that an event with comment and status portions stays unread until both portions have been visible. The final focused run used one worker; no full suite or build was run as part of this independent QA. The Playwright server was stopped and port 3100 was free after the run.
