# План незалежного desktop-аудиту після виправлень — 2026-10-04

Запит користувача: виправити відомі проблеми через Luna max, потім незалежно перевірити всі сценарії UI й шукати нові дефекти. Цей план визначає покриття; до фактичних результатів він не є заявою про проходження сценаріїв.

## Середовище й докази

- Основна перевірка — ізольований demo з окремою SQLite та порожнім токеном; real preview лише GET/HEAD, без зміни особистих налаштувань/непрочитаних.
- Заборонені будь-які Redmine/Trello mutations. Токен/.env не читати та не виводити. Read-only transport guards мають залишитись перевіреними.
- Розрізняти ручну браузерну перевірку, автоматизований сценарій, кодове припущення та неперевірене. Для кожного сценарію записати результат/помилку/межу. Не називати весь UX перевіреним на основі лише проходження попередніх E2E.
- Незалежний аудитор починає зі щоденних задач користувача, а не з попередніх дефектів. Для нової знахідки потрібні кроки відтворення, очікувана/фактична поведінка, severity та стан середовища.
- Native trackpad/Shift-wheel, clipboard permissions та browser/device notifications позначити окремо, якщо інструмент не підтримує реальний сценарій. Мобільний UX відкладено.

## Матриця сценаріїв

| Область | Що пройти |
| --- | --- |
| Запуск і режими | Demo, real read-only, loading/failed connection/retry; відсутність silent demo fallback та витоку секретів; компактний режим видимий із sidebar/modal. |
| Навігація | Вибір проєкту, Board/Inbox/Releases/Settings, прямі URL картки/коментаря/форми; refresh, Back/Forward, закриття modal, неіснуючий issue/project. |
| Sidebar | Cmd/Ctrl+B, кнопка, localStorage після reload, доступність навігації зі згорнутим sidebar, фокус. |
| Дошка | Природна висота 0/1/багато карток; довгі колонки; горизонтальний/вертикальний скрол над картками/порожньою зоною; різні ширини desktop; закріплені release cards; сортування й duplicate/hidden issues. |
| Workflow/DnD | Між статусами; Review/QA→To Do developer restoration; Join→QA assignee; drop у реліз membership only; Deploy з version→release lane; помилка/rollback; autoscroll. Тільки demo. |
| Views/filters | All/Mine/Watching/Backlog, Q toggle не стирає інші фільтри; поповер не зсуває дошку, multi-label/assignee/priority/type/status; clear/save/rename/delete custom filters; пустий результат. |
| Пошук | Subject/description/comment/ID/branch/labels згідно фактичного backend coverage; current/all projects, completed issues; empty/loading/error/pagination, stale response після зміни query/project; opening result/back. |
| Створення | Global і кожна колонка, status/version prefill, title/description/required fields, priority/type tiles, recommended assignees/full picker; cancel/draft/reopen; invalid/save/error/double submit; Branch після ID. Тільки demo save. |
| Редагування | Autosave status/people/version/labels, explicit title/description/comments; Cmd/Ctrl+S active form; rapid changes/rollback/concurrent refetch; draft close/reload, blocked real save preserves draft. |
| Люди й аватари | Author/developer/QA/assignee/watchers/journal/Inbox roles; non-member override; same person different project roles; selected shapes; 2 initials; local photo/emoji/failure/reset/scope/restart. |
| Activity | Newest-first/ties, comments-only and category filters autosave across same-project cards, isolation other project; permalinks temporarily reveal hidden target; resolved names/labels/unknown values, large journal/empty journal. |
| Коментарі | Add/edit/delete/like/unlike, quote, copy exact permalink, focus target; multiline/fenced code/images; draft/failed save/cancel/keyboard; permissions. Реальні writes не виконувати. |
| Контент | Markdown headings/lists/links/code, safe HTML, protected attachment/image display/failure, external unavailable assets/fallback, raw editor preserved. |
| Branch/clipboard | Generate/copy Branch, copy Redmine URL Cmd/Ctrl+C while respecting selected text, comment URL; unavailable clipboard error, shortcut context. |
| Inbox | Groups latest-first; inner events newest-first; expand without read; exact event open/read; group/all mark-read, archive/unread, project subscription/default assigned events/self exclusion; new event/refetch/cross-project roles. |
| Favicon | Unread→fewer→zero, new event, mutation failure keeps count, navigation/refocus; favicon without sound/device notifications. Demo only state changes. |
| Релізи | Create/edit project-only release/NEXT, add any status, active/closed display, all release tasks incl Done; readiness Deploy or successful Done, Rejected not success; completion/partial failure/recovery. Demo only writes. |
| Налаштування | Autosave theme/palette/language/QA/roles/Activity/subscription/backgrounds; validation/error/rollback; photo/emoji; cross-project isolation; shortcut drafts explicit save/cancel not clobbered by autosave. |
| Shortcuts | Q/B/S/Cmd+S/Cmd+B/Inbox/Settings/create/search/labels/move/copy; reassignment/collision/invalid chords; textarea/input/popover/modal focus; platform Cmd/Ctrl. |
| Автоматизації | Rule setup/toggle/edit/delete if supported, CI In Progress→Failed in Review restores developer; background while tab closed; planned/blocked real actions, operation log, retry without duplicates; only demo execution. |
| Візуальна якість | Light/dark/all palettes, compact text, priority and labels prominence, role shapes, disabled/hover/focus/error states, background readability, duplicate metadata. |
| Клавіатура/a11y | Logical tab order, modal focus trap/restore, Escape, popover keyboard selection, accessible labels/selected states, no shortcuts while typing; no mouse-only essential action. |
| Порожні й помилкові стани | No projects/issues/events/releases/members, missing permissions, API error/disconnect, pending request; meaningful retry, drafts retained, no misleading success. |
| Persistence | Reload/restart URLs/settings/backgrounds/avatars/notification states/drafts; per-instance/user isolation; no token in browser bootstrap/logs/build. |

## Результат

Аудит має дати окремо: фактичне покриття матриці, нові проблеми, регресії виправлень, обмеження інтеграції й неперевірені сценарії. Критичні знайдені дефекти виправити та повторно перевірити в межах поточного завдання; дрібні нові UX-пропозиції документувати без нескінченного розширення обсягу.
