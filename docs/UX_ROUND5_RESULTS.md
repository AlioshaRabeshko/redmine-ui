# UX round 5 — результат інтеграції

Дата: 2026-10-14. Реалізацію, браузерну перевірку й незалежне рев’ю делеговано `gpt-6-luna` з `max` reasoning; основний агент інтегрував контракти, переклади та перевірки.

## Що змінилося

| Вимога | Результат |
| --- | --- |
| Форматування та код | Визначення фактичного formatter інстансу, CommonMark/GFM і Textile preview, санітизований raw HTML, підсвічування лише явної мови. |
| Згадки | Підказки учасників поточного проєкту з підтвердженим Redmine login; доставка згадок лишається Redmine. |
| Developer | Значення виключно з точного свіжого `Primary Assignee`; старі локальні Developer не використовуються й не переносяться. |
| Нові картки | Окрема project subscription `issue_created`, cutoff на час увімкнення, тихий baseline нових/повторно доступних проєктів. |
| Видалені статуси | Свіжий каталог, доступні задачі у спільній недоступній для drop колонці невідомого статусу. |
| Конфліктні чернетки | Окреме відкидання чернеток картки, Branch і конкретного коментаря, з очищенням persistent та session fallback. |
| Preview і WYSIWYG | Preview опису за замовчуванням, клік для редагування, візуальне форматування під час набору й окремий source mode. |
| Дії з коментарями | Команди та capability guards; реальні edit/delete/like лишаються недоступними без підтвердженої підтримки інстансу. |
| Переходи статусу | Лише свіжі per-issue `allowed_statuses`; відсутній або порожній список не замінюється глобальним каталогом. |
| Згортання колонок | Вузькі рейки з назвою й кількістю, project persistence і drop за чинними правами. |
| Високі пріоритети | Залиті Urgent/Immediate зі світлими й темними контрастними кольорами. |
| Зображення | Issue-scoped безпечне завантаження, явний retry і скидання старої помилки при зміні URL/attachment. |
| Групи | Типізоване user/group призначення в creation/detail; однакові числові IDs не змішують людей і групи. |
| Watcher | Picker, chip, URL, saved view та серверна фільтрація за watcher. |

Браузерна перевірка також виявила native label activation: обгортка редактора могла автоматично активувати першу кнопку Bold при кліку по тексту, переміщувати фокус і змінювати форматування нового вводу. Для composite editor використовується звичайний контейнер із доступним іменем редактора. Клік, Shift-click, виділення перетягуванням і plain/bold roundtrip перевіряються реальними pointer/keyboard подіями. Також закрито нормалізацію untouched source через службовий `setEditable` update, скидання вручну вибраного Source-режиму при цитуванні й неправильну позицію курсора після quote append. Нові demo задачі отримують відомий список переходів із demo catalog; невідомі real permissions залишаються невідомими.

Незалежний review додатково закрив втрату дозволеного CommonMark raw HTML, хибний `OUTCOME_UNKNOWN` у read-only worker, історичні creation events після частково невдалої синхронізації та гонку підписки з opt-out. Транзакції перевіряють чинні налаштування в момент фіксації події; read-only automation блокується до adapter GET/PUT і не повторюється після повторного ввімкнення запису.

## Перевірки

- `npm test -- --run` — 45 файлів, 300/300 unit/server тестів після фінального adapter permission-shape guard.
- Host production build/typecheck і Docker production build — успішні; SQLite native binding додатково перевірено у disposable image без мережі й mounts через `:memory:` `SELECT 1`.
- Targeted editor/comments/issue audit — 21/21; targeted moves/board/legacy UX/visual — 26/26 після виправлень.
- Повний Chromium — 127/127, 3 хв 6 с, на фінальному production build після виправлень; весь набір запущено на свіжій isolated demo DB.
- Переглянуто 12 desktop-скриншотів: 1280/1600, light/dark, згорнута дошка, preview і visual editor. Дубльований рядок Preview/Edit прибрано; повторний pixel review підтвердив чистий preview.
- Усі browser/server mutation checks — isolated demo/mocks. Жодних зовнішніх тестових записів; мобільний аудит відкладено.

Початкові неповні прогони не зараховані як успішний повний gate. Вони виявили product defects (label activation, untouched source normalization, quote mode/focus, demo transition metadata) і stale test fixtures/selectors (locale, typed assignee IDs, loading race, змішаний Textile/Markdown image fixture, persisted collapse та залежність CI fixtures від dotenv labels). Assertions про точний source, in-flight drafts, статус/виконавця CI, optimistic moves і resolver boundaries збережено. Playwright тепер явно задає свої CI labels, не змінюючи runtime-конфіг користувача.

## Локальний запуск

Docker preview оновлено на localhost:3010 зі збереженням named SQLite volume і раніше дозволеного runtime write opt-in. Після першого recreate Compose підставив placeholder URL: backend GET виявив DNS `ENOTFOUND`. Відновлено тільки раніше підтверджений `REDMINE_URL` в ignored локальному конфігу; токен, режим запису та решту налаштувань не змінювали й не виводили. Повторний звичайний Compose startup і GET-only smoke підтвердили `connected=true`, `readOnly=false`, `canWrite=true`, `textFormat=common_mark`, assets HTTP 200. Це не mutation smoke реального Redmine.

Після повного browser gate додано fail-closed нормалізацію nullable/malformed `allowed_statuses`; adapter/sync перевірки 36/36 і typecheck пройшли. Фінальний image перебудовано й повторно перевірено GET-only. Client і нормальні demo permission contracts не змінювалися.

## Межі сумісності

GET-only дослідження підтвердило `common_mark` підключеного інстансу та точне поле `Primary Assignee` у свіжій задачі. Admin catalog повертає 403; backend використовує точний ID поля із самої задачі, перевіряє доступні метадані, покладається на Redmine validation і звіряє результат повторним читанням. Права, role/tracker і налаштування груп можуть відхилити призначення; помилка сервера показується чесно.

Точна версія Redmine і приватний `common_mark_enable_hardbreaks` не встановлені. Preview використовує стандартні soft line breaks. Alert-візуалізація й CJK-specific parsing не реалізовані; це не заява про повну тотожність кожного розширення Redmine. Складні та невідомі блоки зберігаються точними атомами у візуальному редакторі й доступні через source mode. Якщо formatter невідомий, показується чесний source-only режим.

Підтримку власних journal edit/delete поточного інстансу не підтверджено; likes не мають перевіреного API. Ці дії лишаються закритими в real mode. Усі мутаційні тести виконували лише в isolated demo/mocks; зовнішніх Redmine/Trello/production DB мутацій для перевірки не виконували. Мобільний аудит відкладений за попереднім рішенням користувача.

Окремі звіти: [backend](UX_ROUND5_BACKEND.md), [board](UX_ROUND5_BOARD.md), [editor](UX_ROUND5_EDITOR.md), [незалежний review](UX_ROUND5_REVIEW.md). Окремий legacy review: [UX_ROUND5_LEGACY_QA.md](UX_ROUND5_LEGACY_QA.md). Браузерні докази: [UX_ROUND5_QA.md](UX_ROUND5_QA.md). Локальне оновлення: [UX_ROUND5_DEPLOY.md](UX_ROUND5_DEPLOY.md).
