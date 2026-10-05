# UX round 3: notifications and Inbox

## Implemented behavior

- Inbox groups remain organized by issue, but every event is visible immediately in newest-first order. A group title uses the current cached subject, then a subject saved with a notification, then a translated `Issue #ID` fallback. The title does not repeat the latest event text.
- Notification rows use structured journal notes and changes. Field names and values go through the same `localizeJournalChange` renderer as issue Activity and use status, person, priority, release, and project label catalogs. Unknown numeric values remain explicit as `Unknown (#ID)`; they are not guessed.
- `/api/notifications` hydrates old notification payloads from locally cached issues and journals in one local projection path. It makes no per-event Redmine request. Current project event preferences filter the returned notes and changes, including the content of mixed journals and events on issues assigned to the current user.
- A missing project preference uses the agreed `comment` default. An explicit empty event list stays empty. Assignment affects whether an issue is eligible for notifications; it does not bypass the event mask, even when the board subscription is disabled.
- Preference changes are a read-time projection. Hidden events are omitted from the returned Inbox and unread index, while their notification rows, IDs, timestamps, `readAt`, and source journals remain in SQLite. If a category is enabled again, the event can appear again without replaying a remote request.
- When an old notification has no journal in the cache, comments can still use their stored text. Other event types show a translated unavailable-details message instead of raw field IDs.
- New settings and the environment fallback use a 10-second poll interval. Existing explicit intervals remain intact. Older persisted settings do not record whether `30` was a user choice or the former default, so this change keeps a persisted value of `30` rather than overwriting it without provenance.

## Validation

Targeted unit and server tests passed: 6 files, 18 tests. They cover assigned-to-me eligibility with comments-only and empty masks, mixed journal projection, local hydration, project-specific label catalogs, stable read state, old comments, unknown IDs, saved-view notification filters, and sync interval defaults/custom values.

`e2e/round3-notifications.spec.ts` adds browser coverage for expanded event lists, subject headers, newest-first ordering, localized label changes, and reading one event without acknowledging siblings. It was authored but not run in this source handoff; the parent source gate owns integrated E2E execution.
