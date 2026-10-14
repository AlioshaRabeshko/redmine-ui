# Незалежний review UX round 5

Дата: 2026-10-14

## Попередня клієнтська знахідка — виправлено

**P2 — CommonMark-вміст із дозволеним Redmine HTML зникає з попереднього перегляду.** У [RichContent.tsx](/Users/oleksii/work/redmine-ui/src/client/components/RichContent.tsx:168) HTML з CommonMark передається до `ReactMarkdown` з `skipHtml` ([рядок 185](/Users/oleksii/work/redmine-ui/src/client/components/RichContent.tsx:185)). Попередня обробка [redminePreviewSource](/Users/oleksii/work/redmine-ui/src/client/components/redmineFormatting.ts:344) перетворює `<pre><code>` лише для Textile ([рядок 346](/Users/oleksii/work/redmine-ui/src/client/components/redmineFormatting.ts:346)). Тому сирий CommonMark-фрагмент

```html
<pre><code class="language-ruby">puts 1</code></pre>
<img src="https://example.test/diagram.png" alt="Diagram">
```

не стає ані підсвіченим блоком коду, ані зображенням у картці/попередньому перегляді. Це відрізняється від поведінки форматера CommonMark Redmine: його конфігурація дозволяє raw HTML, а санітайзер зберігає обмежені `pre`, `code` та `img` елементи й обмежений клас мови. Підтвердження: [офіційний форматер Redmine](https://github.com/redmine/redmine/blob/master/lib/redmine/wiki_formatting/common_mark/formatter.rb), [офіційний санітайзер](https://github.com/redmine/redmine/blob/master/lib/redmine/wiki_formatting/common_mark/sanitization_filter.rb) та [довідка Redmine про Markdown](https://www.redmine.org/projects/redmine/wiki/RedmineTextFormattingMarkdown).

**Статус 2026-10-14: виправлено.** CommonMark raw HTML тепер проходить `rehype-raw` та суворий `rehype-sanitize` allowlist; зображення маршрутизуються через issue-scoped resolver, а raw code text захищається з урахуванням Markdown fences, inline spans та macros. Renderer unit-тести і typecheck пройшли; фінальний build і браузерну регресію виконує інтеграційний gate.

Опис вище відображає початковий стан, у якому raw HTML зникав через `skipHtml`. У виправленому tree вузький санітайзер зберігає дозволені конструкції, а зображення проходять issue-scoped resolver; renderer unit-тести покривають дозволені й заборонені приклади. Інтеграційний build/browser gate залишається поза цим read-only review.

## Перевірене покриття та межі

- Прочитано UX round 5, backend/editor/board звіти та останні продуктові рішення в `RESEARCH.md`; переглянуто клієнтський шлях форматування/рендерингу, пов'язані editor, issue-dialog, board/filter/settings зміни та відповідні серверні межі, з фокусом на регресіях поза вже відомими виправленнями.
- Точковий запуск Vitest: `npx vitest run src/client/components/redmineFormatting.test.ts src/client/components/RichContent.test.tsx src/client/lib/workspaceNavigation.test.ts src/server/notifications.test.ts` — 4 файли, 34 тести пройшли на момент запуску.
- E2E, повний набір тестів і сервер не запускав: E2E та demo-середовище належать QA-перевірці; уникнув паралельного запуску з ними. Три backend-знахідки повторно перевірив після виправлень нижче; звіт backend зазначає typecheck та 294 пройдені тести.
- Не перевіряв фактичну версію чи конфігурацію підключеного Redmine; зіставлення дозволеного HTML спирається на офіційний код і довідку Redmine, а не на пробний запит до реального сервера. Не виконував зовнішніх мутацій і не звертався до production/staging БД.

## Окремий review серверних змін

Повторно перевірено три попередні backend-знахідки на оновленому working tree: `RealCommandExecutor`, worker bridge, `SyncService`, `WorkspaceStore` і відповідні регресійні тести. `docs/UX_ROUND5_BACKEND.md` звітує про typecheck і 294 успішні тести; у цьому проході їх не запускав повторно.

### Статус попередніх знахідок

**Виправлено — read-only worker більше не запускає й не повторює стару CI-автоматизацію.** `RealCommandExecutor.execute()` відхиляє write-команди до черги й adapter-викликів, коли write-mode вимкнений ([real-executor.ts:32–40](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:32)). Worker окремо знаходить persisted pending real automation і до перевірки налаштувань чи віддаленого стану переводить її в `blocked / READ_ONLY` ([real-executor.ts:91–121](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:91)); `openRecord()` забороняє повторити такий operation ID після re-enable ([real-executor.ts:124–134](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:124)). Регресійний тест перевіряє, що worker/direct retry не викликають issue read чи поточну user lookup та не виконують create/update write, а також перевіряє durable block, коли automation вимкнена ([real-executor.test.ts:149–178](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.test.ts:149)). Це підтверджує саме потрібну межу; початкове твердження про можливий production PUT було неправильним і вже уточнене вище.

**Виправлено — partial sync більше не змінює визначення останнього успішного project scope.** Для creation events береться `successfulProjectIds`, а не змінюваний project catalog ([sync/service.ts:66–72](/Users/oleksii/work/redmine-ui/src/server/sync/service.ts:66)); scope і baseline cursor просуваються разом лише після завершення обробки snapshot ([sync/service.ts:203–207](/Users/oleksii/work/redmine-ui/src/server/sync/service.ts:203), [store.ts:263–274](/Users/oleksii/work/redmine-ui/src/server/db/store.ts:263)). Тест моделює повернення доступу до проєкту з попереднім activation cursor, interruption після збереження project row та успішний retry; історичну задачу позначено seen без сповіщення ([sync.test.ts:137–180](/Users/oleksii/work/redmine-ui/tests/sync.test.ts:137)).

**Виправлено — поточний sync більше не перезаписує PATCH налаштувань і перевіряє subscription на момент commit події.** Проєктні defaults зливаються в транзакції з найновішими налаштуваннями, додаючи лише відсутні ключі ([sync/service.ts:119](/Users/oleksii/work/redmine-ui/src/server/sync/service.ts:119), [store.ts:207–229](/Users/oleksii/work/redmine-ui/src/server/db/store.ts:207)). `commitIssueCreatedEvent` атомарно фіксує source event, читає актуальну subscription і activation cursor та додає notification лише за чинного opt-in ([store.ts:232–261](/Users/oleksii/work/redmine-ui/src/server/db/store.ts:232)). Barrier-тести охоплюють PATCH між читанням settings і merge, а також opt-out після збереження issue до event transaction; обидва гарантують збереження opt-out і відсутність notification ([sync.test.ts:183–240](/Users/oleksii/work/redmine-ui/tests/sync.test.ts:183)). Подія, чий transactional commit уже завершився до opt-out PATCH, може залишитися; цей порядок відповідає серіалізації commit-ів.

### Що перевірено як захищене

- Fresh issue custom field binding приймає лише один точний `Primary Assignee` із позитивним ID та відхиляє масивне value; доступні метадані перевіряються на конфлікт із типом `User`, множинністю та project/tracker applicability ([adapter.ts:795–816](/Users/oleksii/work/redmine-ui/src/server/redmine/adapter.ts:795)). Оновлення прив'язує саме свіжий ID поля та звіряє прочитане значення після PUT ([real-executor.ts:871–890](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:871)).
- Тип групи підтверджується через свіже членство у проєкті, а після запису перевіряються ID і тип із повторного читання; обмеження `issue_group_assignment` та workflow лишені на серверну валідацію Redmine ([real-executor.ts:1061–1095](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:1061)).
- Читання/запис real-store прибирає стару локальну роль `Developer`, а automation повертається за свіжим `issue.primaryAssigneeId`, не з кешованого `issue.developerId` ([store.ts:251–273](/Users/oleksii/work/redmine-ui/src/server/db/store.ts:251), [real-executor.ts:770–790](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:770)). Для актуальних flow не знайшов старого локального Developer fallback у real store/automation.
- Журнальні PUT передуються capability guard; поточна sync-процедура не виставляє ці capability, тож у реальному режимі edit/delete лишаються закритими. Команди likes відхиляються без REST PUT ([real-executor.ts:431–453](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:431)).
- Невідомий результат запису фіксується до повернення керування, а повтор операції з `OUTCOME_UNKNOWN` блокується; неоднозначний запис журналу також не відправляється вдруге ([real-executor.ts:88–115](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:88), [real-executor.ts:900–937](/Users/oleksii/work/redmine-ui/src/server/commands/real-executor.ts:900)).

Цей проход був read-only: не запускав app/server, E2E, build чи повний suite; не читав `.env`, не виконував мережевих записів або звернень до БД. Клієнтську CommonMark raw-HTML знахідку після review виправлено; targeted unit-тести й typecheck проходять, а фінальний build/browser gate ще належить виконати.
