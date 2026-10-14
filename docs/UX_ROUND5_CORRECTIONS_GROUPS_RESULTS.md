# UX round 5 corrections: group avatars

Group photo and emoji overrides now use their own `groupAvatarOverrides` settings map and `groupAvatar:<id>` SQLite storage key. The local group-avatar routes validate group IDs against cached project-group membership, accept only PNG, JPEG, or WebP images up to 2 MiB, and expose versioned local URLs. Settings keep group selection and avatar editing separate from person role and QA controls.

Group avatars render in the assignee picker, issue board cards, backlog rows, and settings preview. Groups and users with the same numeric ID remain distinct through typed assignee options, separate settings maps, and separate routes. Failed settings saves attempt to remove their newly uploaded local image; replacing or clearing an avatar also removes the prior local image after the preference is saved.

Verification completed:

- `npm run typecheck` — passed.
- `npx vitest run src/server/group-avatars.test.ts src/server/group-avatar-settings.test.ts` — 2 files and 5 tests passed, including the group/user ID collision, upload validation, version retention, and cleanup behavior.
- Added `e2e/round5-corrections-groups.spec.ts` for isolated demo-mode photo, emoji, reload, rendering, removal, and error-path coverage. It was not run in this task; integration and browser checks are left to the parent task.

No Redmine writes, production database operations, build, or app/browser run were performed.
