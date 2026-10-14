# UX round 5: результати backend-виправлень і перевірки журналів

## Що змінилося

Повторні metadata reads прибрано зі звичайного відкриття задачі. `issueDetail()` більше не запитує `/custom_fields.json`: точний ID `Primary Assignee` береться зі свіжої відповіді задачі, а вже відомі описи полів можуть лише відхилити суперечливий binding. Каталог custom fields лишився кешованим на п'ять хвилин із singleflight для одночасних читань.

Успішний snapshot зберігає IDs і назви груп із project memberships. Варіанти assignee для читання використовують обмежений кеш проєкту на п'ять хвилин; запити `/groups/:id.json?include=users` більше не виконуються. `projectMemberships()` для реального запису кожного разу повторно читає Redmine, тож UI-кеш не надає і не продовжує право призначення.

HTML-сторінки редагування labels мають bounded cache на п'ять хвилин із лімітом 256 issue/field наборів і singleflight. Кешуються також порожній результат і помилка, щоб після невдалого холодного lookup наступні відкриття не повторювали GET. Якщо варіантів немає, перше відкриття ще може спробувати `issues/:id/edit` і read-only `issues/:id`; жодну HTML-форму не відправляють.

Кожен успішний real sync явно записує `journalEditing`, `journalDeleting` і `journalLikes` як `false`. Це очищає будь-які старі capability bits і не переносить права між користувачами чи інстансами. Real executor відхиляє edit/delete до читання задачі, якщо capability не підтверджена. Лайки лишаються непідтриманими.

## Що підтверджено про Redmine Journals

Офіційна [REST-документація Journals](https://www.redmine.org/projects/redmine/wiki/Rest_Journals) описує `PUT /journals/:id.json` для зміни `notes` і вимагає право редагувати нотатки. Вона описує очищення через `notes: ""`: запис без деталей журналу видаляється, а журнал зі змінами залишається без нотатки. Отже, ця дія не є DELETE HTTP і не стирає історичні зміни.

Офіційна [таблиця REST API](https://www.redmine.org/projects/redmine/wiki/Rest_api) відносить Journals до API, доступного з Redmine 5.0. Поточний upstream core [дозволяє API-key auth для update](https://github.com/redmine/redmine/blob/master/app/controllers/journals_controller.rb) і перевіряє `Journal#editable_by?`; [модель](https://github.com/redmine/redmine/blob/master/app/models/journal.rb) дозволяє редагування адміністратору з `edit_issue_notes` або автору з `edit_own_issue_notes` у проєкті. Це підтверджує загальний core-контракт, але не версію, plugin hooks чи права конкретного облікового запису в цільовому Redmine.

Core перевіряє API-запит за форматом `xml` або `json` у [`ApplicationController#api_request?`](https://github.com/redmine/redmine/blob/master/app/controllers/application_controller.rb); у `JournalsController` API-auth увімкнено для `update`, а не для HTML `edit`. Тому без browser session API key не відкриває HTML edit/show UI, з якого можна було б прочитати власні кнопки. Перегляд HTML через браузерну сесію не виконувався.

В upstream core є окремі web routes для [`reactions`](https://github.com/redmine/redmine/blob/master/config/routes.rb), але [controller](https://github.com/redmine/redmine/blob/master/app/controllers/reactions_controller.rb) вимагає login, обмежує відповідь форматом JavaScript і повертає 404 для інших форматів. Це не підтверджує REST/API-key операцію для journal likes чи контракт цільового plugin. Тому likes залишаються недоступними в real mode.

## Безпечна перевірка цільового інстансу

Для `https://redmine.example.com` виконано лише обмежені GET-запити із backend-транспортом і наявною конфігурацією. Response bodies лишалися в пам'яті; до звіту потрапили HTTP-статуси, project ID для зіставлення ролей і точні role IDs. User, issue та journal IDs, імена, нотатки, API key, довільні заголовки й `.env` не виводилися.

- `/users/current.json?include=memberships` повернув `200`; один доступний issue list і його `include=journals` detail також повернули `200`. Detail містив власну нотатку поточного API-користувача.
- У membership цього користувача для проєкту `52` перелічено три ролі: `3`, `4`, `13`. Усі три точні `/roles/:id.json` відповіді повернули `200`, містили коректний масив `permissions` і право `edit_own_issue_notes`; роль `3` додатково містила `edit_issue_notes`.
- GET `/admin/info` перенаправив на `/login` (`302`). Усі сім відповідей під час Role probe не мали заголовка `X-Redmine-Version`, тож точну версію не підтверджено.
- GET `/journals/:id.json` для знайденого власного запису повернув `404`. Це узгоджується з upstream core routes, де для journal є `edit`, `update` та `diff`, але немає `show`; 404 не визначає, чи доступний документований `PUT`.
- Жодного `PUT`, `POST` або `DELETE` до реального Redmine не відправляли.

Отже, GET Roles підтвердив право поточного користувача на `edit_own_issue_notes` для проєкту `52` за даними трьох фактичних membership roles. Однак цільова версія Redmine й підтримка Journals REST на цьому інстансі не підтверджені, тому real edit/delete лишаються fail-closed; позитивний project-scoped permission не переноситься на інші проєкти або користувачів.

## Перевірка запитів і тестів

Mocked transport assertions перевіряють холодне та повторне відкриття: перший lookup label form виконує не більше двох HTML GET, а негативний кеш прибирає їх із повторного відкриття; `issueDetail()` не виконує custom-field catalog, memberships чи group-profile GET. Після snapshot detail і cached assignee choices не додають цих metadata GET. Два окремі виклики `projectMemberships()` виконують два membership reads, як потрібно свіжій перевірці перед записом.

Також перевірено, що успішний sync стирає старі `true` journal capability bits, а real edit command із непідтвердженим правом завершується до будь-якого issue GET/PUT. Цільовий сервер не профілювали, тому звіт не приписує йому конкретну затримку; докази продуктивності — кількість запитів у mocked tests.

Три цільові suites завершилися успішно: 57 тестів для Redmine adapter, sync і real executor. `npm run typecheck` після виправлення браузерних тестів завершився успішно. Подальшу перевірку прав через REST Roles описано нижче.

## Уточнення capability-перевірки через REST Roles

Офіційний [REST Roles контракт](https://www.redmine.org/projects/redmine/wiki/Rest_Roles) визначає `GET /roles/:id.json` як читання permissions конкретної ролі; документація зазначає цей detail endpoint з Redmine `2.2.0`. [REST Users](https://www.redmine.org/projects/redmine/wiki/Rest_Users) дозволяє `GET /users/current.json?include=memberships` і повертає membership та role IDs поточного користувача. Така відповідь може містити його `api_key`, тому probe не друкував і не зберігав payload: він залишив у пам'яті лише user ID для зіставлення автора, проєкт/role IDs і bool-перевірки permissions. Офіційна [REST Memberships документація](https://www.redmine.org/projects/redmine/wiki/Rest_Memberships) підтверджує, що membership належить користувачу чи групі, а успадковані ролі позначаються `inherited="true"`.

У поточній core-моделі користувач одержує об'єднання project roles із membership; [`User#allowed_to?`](https://github.com/redmine/redmine/blob/master/app/models/user.rb) перевіряє permissions цих ролей у межах конкретного проєкту, з окремим admin bypass. [`Journal#editable_by?`](https://github.com/redmine/redmine/blob/master/app/models/journal.rb) дозволяє автору нотатки змінювати її за `edit_own_issue_notes` або будь-якому користувачу з project permission `edit_issue_notes`. Цільова відповідь дає позитивний доказ для own-note permission у проєкті `52`, але не підставу ставити глобальний/admin flag.

Офіційна [REST Journals документація](https://www.redmine.org/projects/redmine/wiki/Rest_Journals) описує оновлення через `PUT /journals/:id.json`; окремий [REST API compatibility table](https://www.redmine.org/projects/redmine/wiki/Rest_api) указує Journals із версії `5.0`. У [core routes](https://github.com/redmine/redmine/blob/master/config/routes.rb) немає GET show для `/journals/:id`, тому target `404` є очікуваним і не доводить ані підтримку, ані відсутність `PUT`. HTML `edit` також не дає безпечного capability signal через API key: upstream [`JournalsController`](https://github.com/redmine/redmine/blob/master/app/controllers/journals_controller.rb) оголошує `accept_api_auth :update`, а [`ApplicationController#api_request?`](https://github.com/redmine/redmine/blob/master/app/controllers/application_controller.rb) розпізнає лише `xml/json` як API-запит. Тому role permission не можна перевірити за HTML edit-кнопкою без browser session. Оскільки жоден probe не відкрив точну версію (header відсутній, `/admin/info` вимагає login), не можна стверджувати, що target має REST Journals API з `5.0` або сумісну plugin-реалізацію.

Якщо capability стане можливою для продуктового wiring після незалежного підтвердження версії/API, її контракт має бути лише project-scoped: sync може показувати read-only UI affordance для проєкту, де ролі поточного користувача містять `edit_own_issue_notes` або `edit_issue_notes`; командний executor має безпосередньо перед кожною зміною знову прочитати `/users/current?include=memberships` і точні `/roles/:id` для активного проєкту, звірити author/journal ID/expected notes зі свіжим issue detail і тільки тоді відправити `PUT`. Успішний role read на sync не є дозволом для write, роль не надає права іншому проєкту/користувачу, а помилка або неповна відповідь лишає UI та executor fail-closed. Цей turn додав лише дослідження й документацію, без змін коду чи тестів.
