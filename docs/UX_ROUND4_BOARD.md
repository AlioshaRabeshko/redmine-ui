# UX round 4: board and backlog

The backlog view now renders as a single list of issues whose current status is Backlog. It uses the same filter, search, sort, saved-view, URL, and keyboard-navigation controls as the board. Priority descending remains the default through the existing board preference; a selected sort preference also applies to the backlog.

Each compact row shows priority, tracker and issue ID, title, labels, people and project roles, creation time, and last activity. Relative dates follow the selected application locale (`uk`, `pl`, `es`, or `en`); hovering either date shows the exact localized date and time. Last activity uses the issue's `updatedOn` value, including non-comment changes. Long titles and labels may wrap at any character so they cannot widen the list or the page.

Unread events keep their count and open the oldest unread event for that issue. The red badge is a regular keyboard-operable button and remains available when Redmine writes are disabled because opening and reading an event is a local notification action. The board-card badge sits below the people and metadata row; the reserved action space keeps larger counts and due-date text from overlapping it.

The “Move to To Do” action uses the configured To Do status and the same issue-move command as the board. It preserves release membership and is disabled when writes are unavailable, the issue is pending, or the project has no To Do status. The view consumes the `BoardData` supplied by the app, including its optimistic issue projection; handling rollback after a definite failure and refreshing actual state after partial or uncertain writes remain in the app's command path.

The backlog itself has no kanban lanes or drag-and-drop context. New issue creation from the backlog view defaults to the project's Backlog status. Read-only mode still permits opening issues and unread events while keeping mutation actions disabled.

## Validation

Focused backlog date unit tests pass (9/9), covering relative and exact formatting in `uk`, `pl`, `es`, and `en`, plus invalid timestamps. The demo Playwright scenarios are written and await the root integration gate; they have not been run. No real Redmine or Trello mutations are used for these checks.
