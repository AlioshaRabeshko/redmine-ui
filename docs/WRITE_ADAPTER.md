# Redmine write adapter

Updated 2026-10-05. Redmine writes are available only when the backend is running in real Redmine mode with `REDMINE_WRITE_ENABLED=true`. Missing or any other value keeps the adapter read-only. Demo mode stays isolated even if the flag is set.

The transport permits `GET` and `HEAD` in either mode. It rejects `POST`, `PUT`, and `DELETE` before calling `fetch` unless the backend flag is enabled. Enabled writes are limited to JSON `POST`/`PUT` bodies and bodyless `DELETE`; other methods and form submissions remain unsupported. Requests stay on the configured Redmine origin and base path, do not follow redirects, and are never retried automatically. A timeout or lost network response is reported as an unknown write result so the caller can verify current Redmine state before retrying.

## Verified standard endpoints

| Adapter method | Redmine request | Notes |
| --- | --- | --- |
| `createIssue(fields)` | `POST /issues.json` with `{ "issue": fields }` | The returned issue is mapped immediately, preserving its ID without a follow-up request. |
| `updateIssue(id, fields)` | `PUT /issues/:id.json` with `{ "issue": fields }` | `notes` uses the documented issue update path for a comment. |
| `createVersion(projectId, fields)` | `POST /projects/:project_id/versions.json` with `{ "version": fields }` | Returns the Version from the create response. |
| `updateVersion(id, fields)` | `PUT /versions/:id.json` with `{ "version": fields }` | Redmine may return `204 No Content`. |
| `versionDetail(id)` | `GET /versions/:id.json` | Used for fresh state checks. |
| `updateJournal(id, notes)` | `PUT /journals/:id.json` with `{ "journal": { "notes": notes } }` | This standard API endpoint is implemented, but the app must keep journal edit capability disabled until the installed Redmine version and user permissions are verified. |

The paths and request envelopes above are documented by Redmine's [REST Issues](https://www.redmine.org/projects/redmine/wiki/Rest_Issues), [REST Versions](https://www.redmine.org/projects/redmine/wiki/Rest_Versions), [REST Journals](https://www.redmine.org/projects/redmine/wiki/Rest_Journals), and [REST API](https://www.redmine.org/projects/redmine/wiki/Rest_api) pages. The API documents validation failures as `422 Unprocessable Entity`; the transport returns only bounded, sanitized `errors` strings and never relays the raw response body or secret fields.

`writeFieldMetadata(projectId, sampleIssueId?)` reads Redmine's custom-field catalog and, when needed, one issue or its read-only form to return only Branch/Labels/Tags field IDs and label option IDs/names. It does not return issue field values and does not submit an HTML form.

## Deliberate capability limits

The documented `PUT /journals/:id.json` supports notes editing on Redmine versions that implement it and only when the user has the required permission. This does not establish support on the configured private instance. Journal edit UI/capability remains off until that is confirmed. No standard write endpoint was found for journal likes; journal deletion has conditional side effects through empty notes and is not implemented. Both remain unavailable in real mode. No plugin-specific write endpoint is guessed.

The private Redmine instance's version, workflow, required custom fields, and token permissions still need read-only verification. Write adapter tests use only mocked HTTP transports; they do not write to Redmine.
