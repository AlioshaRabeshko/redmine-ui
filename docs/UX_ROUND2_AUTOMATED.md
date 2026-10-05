# Автоматизована перевірка UX round 2

Цей звіт зіставляє автоматизовані перевірки з матрицею `UX_FULL_SCENARIOS.md`. Він описує E2E/unit покриття, а не замінює окремий ручний аудит інтерфейсу.

## Покриття матриці

| Сценарії | Автоматизовані докази | Межі перевірки |
| --- | --- | --- |
| Режими й зовнішні записи | `workspace.spec.ts`, `issue-audit.spec.ts`, `comments.spec.ts`, `backgrounds.spec.ts`; `api-contract.test.ts`, `transport-policy.test.ts`, `redmine-adapter.test.ts`, `commands.test.ts` | Браузерні сценарії працюють лише проти ізольованого demo або маршрутизованих відповідей. Реальний Redmine не підключався; transport/adapter перевірені фіктивним fetch. `.env` і токени не читалися. |
| Навігація, прямі посилання, Back/Forward, refresh, відсутні задачі, фокус modal | `navigation.spec.ts`, `workspace.spec.ts`, `modal-focus.spec.ts` | Перевірено URL/history, delayed GET і lazy chunk, cached-detail handoff, Escape та повернення фокуса з вкладеного підтвердження. Мережеве з’єднання браузера з реальним сервісом не перевірялося. |
| Sidebar і клавіатурні скорочення | `sidebar-shortcuts.spec.ts`, `ux-revision.spec.ts`, `navigation.spec.ts` | Перевірено кнопку, Cmd/Ctrl+B, локальне збереження стану, збереження скорочень і обробку фокуса в полі. Системні клавіатурні розкладки поза Chrome не тестувалися. |
| Дошка, колонки, фільтри, DnD | `board-audit.spec.ts`, `ux-revision.spec.ts`, `workspace.spec.ts` | Покрито порожню/коротку/довгу колонку, синтетичний горизонтальний wheel над карткою, вертикальний скрол колонки, незалежний скрол і DnD autoscroll; фільтри, Q та переходи між workflow-статусами виконуються лише в demo. |
| Release membership та статуси | `board-audit.spec.ts`, `workspace.spec.ts`, `ux-revision.spec.ts`; `commands.test.ts`, `redmine-adapter.test.ts` | Перевірені Deploy-only release lanes, закритий Deploy, збереження roadmap при зміні статусу, завершення release й повтор після заблокованої готовності. Частковий збій багатокрокового завершення release окремим браузерним сценарієм не покривався. |
| Пошук | `search-notifications-audit.spec.ts`, `ux-revision.spec.ts`, `navigation.spec.ts`; `redmine-adapter.test.ts`, `search-attachment-routes.test.ts` | Перевірені поточний/усі проєкти, Done-контент, Back, stale response, сторінки, API-помилка та повтор. Окремо не підтверджено браузером кожне поле індексації на великому живому наборі. |
| Створення й редагування задач | `workspace.spec.ts`, `ux-revision.spec.ts`, `navigation.spec.ts`, `comments.spec.ts`, `issue-audit.spec.ts`, `legacy-drafts.spec.ts` | Перевірені статус/версія з колонки, форма з URL, тип/пріоритет/виконавці, autosave окремих полів, Cmd/Ctrl+S, конфлікт/помилка, гонка вводу, scoped drafts, старі create/edit drafts при quota failure, міграція після відновлення сховища й tombstone. Всі записи — тільки в ізольовану SQLite або браузерний storage. |
| Люди, ролі й локальні аватари | `board-audit.spec.ts`, `ux-round2.spec.ts`, `ux-revision.spec.ts`; `people-settings.test.ts`, `personProjection.test.ts`, `localAvatar.test.ts`, `peoplePresentation.test.ts` | Перевірено role frames різних форм, sparse people snapshots, вибрану рамку при hover/focus, fallback із двох grapheme, локальне фото/emoji, reload/reset, cross-project projection і replacement lifecycle: A лишається чинним після failed PATCH; після успішного B старі bytes прибираються, а при переході на emoji прибираються bytes B. Файловий діалог ОС замінений на програмний `setInputFiles`. |
| Activity і журнали | `ux-round2.spec.ts`, `issue-audit.spec.ts`, `search-notifications-audit.spec.ts`; `issueActivity.test.ts`, `activity-settings.test.ts` | Перевірено newest-first і tie-break, project-wide autosave фільтрів із картки, ізоляцію проєктів та permalink-override прихованого запису. |
| Коментарі | `comments.spec.ts` | Покриті цитата, permalink/copy з дозволом clipboard, like, edit/delete, конфлікт після зовнішньої локальної зміни, Cmd/Ctrl+S, помилка та режим без запису. OS clipboard і відмова в browser permission не тестувалися. |
| Контент задачі | `issue-audit.spec.ts`, `comments.spec.ts` | Перевірено Markdown, безпечний HTML, код, таблиці, вкладене зображення та помилку зображення. Віддалене зображення Redmine не завантажувалося. |
| Inbox і favicon | `ux-round2.spec.ts`, `workspace.spec.ts`, `search-notifications-audit.spec.ts`; `notificationGroups.test.ts`, `favicon.test.ts`, `sync.test.ts` | Перевірено останню подію групи, порядок подій, expand без читання, точне відкриття/читання одного event, групове читання та favicon після успіху/помилки/нової події. Нативні системні сповіщення не запускалися. |
| Settings, тема, фон, Activity, shortcuts | `backgrounds.spec.ts`, `ux-revision.spec.ts`, `search-notifications-audit.spec.ts`, `ux-round2.spec.ts`; відповідні `settings`, `projectBackgrounds`, `peopleSettings` unit-тести | Перевірено autosave, project-scoped background і Activity, локальні аватари, failed settings patch та окреме явне збереження shortcut drafts. |
| Автоматизація | `ux-revision.spec.ts`; `sync.test.ts`, `commands.test.ts` | Браузерний demo-тест закриває вкладку й перевіряє повернення CI Failed з Review у To Do; unit-тести перевіряють вимкнений режим, повтор і блокування real write. Поведінка після зупинки всього процесу застосунку не перевірялася. |
| Помилки й відновлення | `search-notifications-audit.spec.ts`, `ux-revision.spec.ts`, `backgrounds.spec.ts`, `comments.spec.ts`, `navigation.spec.ts`; unit-тести command/API | Покриті search, settings, release create, property, comment, attachment, missing-link і background-upload помилки. Окреме перезавантаження процесу API під час кожного типу запису не перевірялося. |
| Контраст, щільність, focus | `ux-revision.spec.ts`, `board-audit.spec.ts`, `backgrounds.spec.ts` | Автоматизовано перевірені обчислені кольори/контрастні пари для палітр та геометрія/видимість focus. Це не вимірює якість на всіх фізичних дисплеях і не замінює ручний візуальний аудит. |

## Новий негативний сценарій чернетки

Chrome E2E підміняє `Storage.prototype.setItem` так, щоб кидати `QuotaExceededError` лише для `localStorage` ключів issue draft. Перед виправленням це відтворило дефект: після введення унікального опису індикатор стверджував «Чернетку збережено локально», хоча після Escape, повторного відкриття й reload поле поверталося до початкового тексту. Відтворений маркер: `Unsaved when storage is blocked 1791128088772`; початкове значення: `Storage baseline 1791128088761`.

Після виправлення Chrome тест перевірив чесне попередження про недовговічну чернетку й збереження опису та коментаря в межах SPA після закриття/повторного відкриття. Повний reload повернув server baseline і порожній composer, як і попереджає інтерфейс; збереження після reload при відмові localStorage не обіцяється. Звичайний успішний запис окремо проходить reload-тести опису та коментаря.

## Результати прогонів і межі

- Початковий `npm run build` з `APP_MODE=demo` та порожнім `REDMINE_API_TOKEN` пройшов; Vite показав тільки advisory про розмір чанка.
- Фінальний unit-прогін після draft-storage виправлення: **27 файлів, 165 тестів пройшли**.
- Перший повний Chrome прогін мав 70 тестів: 64 пройшли, 6 упали через тестові проблеми (collapsed Inbox, некоректні fixture snapshots, response reuse та надто широкий avatar locator). Ці перевірки виправлені без послаблення продуктових assertions.
- У попередньому раунді збірка після виправлень пройшла `npm run build` з `APP_MODE=demo` і порожнім `REDMINE_API_TOKEN`; лишилося тільки Vite advisory про чанки понад 500 kB.
- Цільова група до виправлення сховища: **21/21** Chrome тест пройшов; окремо Inbox/avatar — **2/2**. Перед виправленням негативний draft test відтворив неправдивий статус і втрату тексту; після виправлення round-two група пройшла **6/6**.
- Попередній повний Chrome прогін: **71/71** тест пройшов за 1.4 хвилини. Це результат попереднього раунду, не поточний follow-up. Автоматизовані перевірки не замінюють ручний аудит і мають межі, перелічені нижче.

Окремий ручний desktop-звіт із фактично пройденими сценаріями, новими UX спостереженнями й обмеженнями доступний у `UX_FULL_BROWSER_AUDIT.md`.

Нативний trackpad/Shift-wheel не симулюється повністю синтетичним `mouse.wheel`; мобільний аудит відкладений. Реальний Redmine і Trello не змінювалися. Усі E2E записи, аватари, releases, comments та автоматизації відбувалися лише в ізольованому demo зі свіжою тимчасовою SQLite і порожнім API-токеном.

## Follow-up прогін після вузьких виправлень — 2026-10-05

- `APP_MODE=demo REDMINE_API_TOKEN='' npm run build`: пройшов, включно з клієнтським і серверним typecheck. Є лише advisory Vite про chunk понад 500 kB.
- `APP_MODE=demo REDMINE_API_TOKEN='' npm test`: **27 файлів, 165 тестів пройшли**.
- Перший Chrome запуск не зміг відкрити loopback listener через sandbox `EPERM` на `127.0.0.1:3100`; порт був вільний, а прямий діагностичний запуск ізольованого сервера підтвердив саме заборону bind у sandbox. Повтор дозволив bind лише для локального demo E2E webServer, з порожнім токеном і тимчасовою SQLite.
- Повний Chrome E2E перед вузьким Settings fix мав **78/79** проходів: усі **5/5** `modal-focus.spec.ts` і **3/3** `legacy-drafts.spec.ts` пройшли. Єдиний збій був у avatar replacement сценарії: після змоканого 500 загальний error notice з’являвся, але цільове повідомлення про невдале збереження аватара очищав effect rollback draft. Це було підтверджено як source finding; assertion не послаблювали.
- Після виправлення lifecycle адресної avatar-помилки повторний build/typecheck пройшов із тим самим лише advisory Vite про chunk понад 500 kB. Цільовий `local person photo and emoji overrides survive reload, apply to board people, and reset independently`: **1/1** пройшов, включно з A → failed PATCH → B → emoji та перевірками старих byte URLs.
- Фінальний повний Chrome прогін після source fix: **79/79 пройшов за 1.4 хвилини**. Він включав усі 5 focus та 3 legacy draft тести і підтвердив avatar failure/replacement/reset. Unit suite **27 файлів, 165 тестів** пройшов перед вузькою effect правкою; після неї повторний build/typecheck і повний Chrome suite успішні.
- Процес E2E завершився; listener на 3100 відсутній. Усі перевірки працювали лише в ізольованому demo з порожнім API-токеном і тимчасовою SQLite. Жодних зовнішніх Redmine/Trello запитів або мутацій не було.
