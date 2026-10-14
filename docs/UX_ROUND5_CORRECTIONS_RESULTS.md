# UX round 5 — виправлення після повторного аудиту

Статус: реалізовано й розгорнуто на localhost:3010. Real journal Edit/Delete/Like лишаються недоступними до підтвердження API цільового Redmine; обмеження описане нижче.

Користувач відновив реалізацію виправлень після audit-only перевірки восьми зауважень. Підтаски редактора, групових аватарів, backend, незалежного браузерного QA та розгортання делеговано `gpt-6-luna` з max reasoning. Первинний стан і причини: [аудит](UX_ROUND5_FOLLOWUP_AUDIT.md).

## Зміни

| Зауваження | Виправлення / межа |
| --- | --- |
| Завеликі проміжки Preview | `white-space: normal` для відформатованого вмісту; код зберігає спеціальне форматування. Нові браузерні перевірки геометрії quote/list/hr. |
| Форматування коментарів | Стилі службових змін Activity обмежено класом `journal-field-changes`. Markdown-параграфи та списки більше не отримують flex/no-marker оформлення. |
| Неактивні Edit/Delete/Like | Непідтверджені per-journal дії приховано. Доступні demo/mocked дії працюють через ті самі guards; REST Roles підтвердив право редагувати власні нотатки у перевіреному проєкті; застосовність Journals REST до версії цільового сервера не підтверджено. API-key шлях likes теж не підтверджено, тому real дії лишаються прихованими та заблокованими. |
| Discard лише при конфлікті | У звичайному dirty стані доступні окремі дії для чернетки картки (title/description/due date) і Branch. Відкидання повертає останні серверні значення та очищає scoped persistent/fallback чернетку, не відкочує вже застосовані серверні зміни. |
| Повільне відкриття | Import діалогу починається паралельно detail GET. Готовий detail показується без очікування board refresh. Порожній composer активує lazy редактор при фокусі; під час завантаження editable textarea зберігає швидкий ввід; відновлений коментар зберігається й показує редактор одразу. Прибрано повторні metadata reads; pre-write membership перевірки залишаються свіжими. |
| Аватар групи | Окрема Settings-картка, photo/emoji override, локальні API та KV-ключі для груп. Показ у board/backlog, detail і Assignee picker; група не потрапляє у Person/QA namespace. |
| Preview не за замовчуванням | Preview відкривається також для відновленої чернетки. Показує текст чернетки з індикатором незбережених змін. |
| Placeholder замість картинки | Markdown inline/reference, Textile та raw `<img>` джерела показуються як selectable image nodes. Resolver спільний із Preview, attachment URL issue-scoped; error/retry працюють окремо. Редагування сусіднього тексту зберігає початкову розмітку картинки. |

## Перевірка

`npm run build` і повний `npm run test` пройшли: **312 тестів у 47 файлах**. Виправлено TypeScript; `git diff --check` чистий. Цільовий браузерний gate пройшов: **11/11 сценаріїв**. Повний Chrome-прогін перевірив **138 сценаріїв**: 135 пройшли, три старі очікування потребували актуалізації (issue вже не чекає board; group avatar має новий селектор; dirty row має також discard). Після цих test-only змін та виявленого повтором виправлення image focus остаточний набір зачеплених файлів пройшов **20/20**, а звичайний click + Delete картинки — **3/3 додаткові повтори** без test-side focus або штучної паузи. Повний прогін після цього не повторювали. Сукупно всі 138 сценаріїв мають успішний результат; це не твердження про один повністю зелений повний запуск.

Фінальний Docker-образ зібрано; його SQLite binding перевірено через ізольований `:memory:`/`SELECT 1` з `--network none`. Запущений localhost:3010 оновлено, контейнер healthy. Іменований том `redmine-ui_workspace-data:/data` збережено. GET health/bootstrap повернули HTTP 200, `mode=redmine`, `connected=true`, `readOnly=false`, `canWrite=true`; HTML і новий `index-BvAAyVnd.js` віддаються з HTTP 200. Потрібне оновлення сторінки у вже відкритому браузері.

IssueDialog JS до виправлення: **1 058 376 байтів**, standalone gzip **323 711 байтів** (наявний попередній build). Нова збірка: **581,29 КБ**, gzip **177,85 КБ**; RichEditor винесено окремо: **485,04 КБ**, gzip **152,09 КБ**. Це розмір build-артефактів, а не вимір часу відкриття вашого Redmine. Внесок backend перевірено mocked request-count assertions: warm detail не додає custom-field/membership/group-profile GET; негативний label HTML lookup кешується. Холодний label fallback ще може виконати два GET.

Жодних реальних мутацій Redmine/Trello чи production DB для перевірок не виконували. Усі команди тестів — isolated demo/mocks. Секрети, `.env`, authentication headers і приватний response body у звіти не потрапляють.

## Детальні результати

- [Редактор і зображення](UX_ROUND5_CORRECTIONS_EDITOR_RESULTS.md).
- [Групові аватари](UX_ROUND5_CORRECTIONS_GROUPS_RESULTS.md).
- [Backend і права журналів](UX_ROUND5_CORRECTIONS_BACKEND_RESULTS.md).
- [Незалежний QA](UX_ROUND5_CORRECTIONS_QA.md).
- [Розгортання](UX_ROUND5_CORRECTIONS_DEPLOY.md).

## Візуальні докази

Primary агент переглянув довгий Preview і той самий source у Activity: цитата, український абзац, довгі марковані елементи, горизонтальна лінія й посилання мають компактні відступи. Обидві картинки створено на demo fixtures.

- [Preview опису](assets/ux-round5-corrections-preview.png).
- [Коментар у Activity](assets/ux-round5-corrections-activity.png).

Під час повторів image click виявився нестійким через наше ручне перехоплення `mousedown` й асинхронний focus. Фінальна реалізація використовує стандартне selectable-node керування ProseMirror; воно синхронно фокусує editor перед NodeSelection. Retry залишається окремою кнопкою. Це продуктове виправлення, а не послаблення тесту.
