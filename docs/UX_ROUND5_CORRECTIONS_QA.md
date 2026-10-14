# UX round 5 corrections — інтеграційний QA

Дата: 2026-10-14. Усі browser-тести працювали в Chrome на `APP_MODE=demo` з тимчасовою SQLite та тестовими API fixtures/routes. Реальні Redmine, Trello й production/staging БД не змінювалися.

## Результат

Root підтвердив фінальний production build і typecheck; unit-набір пройшов **312/312 тестів у 47 файлах**. Мій один повний Chrome прогін містив **138 сценаріїв: 135 пройшли, 3 впали** через застарілі E2E очікування. Після оновлення цих очікувань і фінального image-node fix цільовий rerun із попередніми регресіями та всіма corrections пройшов **20/20 за 50.3 с**. Markdown image click+Delete окремо пройшов **3/3 послідовні повтори за 11.1 с**, без `editor.focus()` або штучної паузи.

Три початкові невдачі були в перевірках, а не в продукті: старий сценарій unread вимагав loading modal замість уже відкритого issue detail; draft-сценарій вибирав усі кнопки рядка після додавання discard; груповий avatar-сценарій шукав старий CSS-клас замість доступного `role="img"`. Нові твердження перевіряють видимий targeted journal і читання тільки його notification ID, submit-кнопку за доступною назвою та названий group avatar. Після корекцій кожен із цих сценаріїв пройшов у цільовому прогоні.

Отже, всі **138 різних Chrome сценаріїв були зеленими щонайменше в одному прогоні**, але **немає одного повного 138/138 прогону**: повний suite запускали один раз до виправлення трьох тестових очікувань. Після цього запускався лише їхній обмежений набір разом із corrections; повний suite не повторювався.

## Покриття corrections

- Чернетки: незалежне відкидання title/description/due та branch очищає саме свою область і прибирає stale draft зі storage/tab fallback без конфлікту; відновлений description draft відкриває Preview та лишається доступним після переходу в edit.
- Коментарі та відкриття issue: journal edit/delete/like controls відсутні без підтверджених capability; у demo дозволені дії працюють. Свіжі issue details з'являються, поки board response ще затриманий; тест перевіряє, що жоден board response не завершився до появи dialog.
- Composer: порожній composer не завантажує RichEditor chunk до активації. При затриманому chunk введені **58 символів** із fallback textarea зберігаються у Visual і Source після його завантаження.
- Group avatars: ID групи, що збігається з ID людини, не плутає налаштування або змонтований board cache; person avatar лишається окремим.
- RichEditor images: Markdown inline/reference/raw HTML і Textile images завантажуються через issue-scoped route як видимі source-backed nodes. Перевірені fail/retry, natural pixels, звичайний click+Delete, видалення raw HTML source та збереження inline/reference source і сусіднього відредагованого тексту.
- Форматування: однаковий довгий source відображається і в Description Preview, і в Activity: цитата **797 символів**, український абзац, три bullets (**336 символів**), горизонтальна лінія та link. Геометричні твердження перевіряють природний whitespace, видимі маркери списку, відступ списку не менше 18 px, проміжки між пунктами не більше 28 px та відстані до сусідніх блоків; норми перевіряються у `.activity-body .rich-content`.

## Структурні performance-перевірки

Тести перевіряють критичний шлях через вимірювані події та кількість запитів, без довільного секундного бюджету: detail response зафіксований до видимого issue dialog, board response іще не завершений, а `mention-users` запитується рівно один раз. Lazy-composer сценарій шукає маркер RichEditor у відповідях JavaScript до активації (його немає), а після активації підтверджує завантаження editor chunk. Затриманий chunk окремо перевіряє збереження введеного тексту до і після release.

Успішні структурні перевірки та саме джерело вимірювання описані в [JSON evidence](assets/ux-round5-corrections-structural-evidence.json); raw navigation latency числом тут не заявляється. Розміри bundle з build вказані в [корекціях результатів](UX_ROUND5_CORRECTIONS_RESULTS.md), вони не є browser latency.

## Візуальні артефакти

Збережені та переглянуті скриншоти повного довгого вмісту:

- [Description Preview](assets/ux-round5-corrections-preview.png)
- [Activity journal](assets/ux-round5-corrections-activity.png)

Перевірка реальних Redmine journal permissions/capabilities не входила до browser suite. UI відсутніх capabilities тестувався в isolated demo fixture; реальні непідтримані journal mutations лишаються fail-closed згідно з backend/adapter audit.
