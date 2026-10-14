# UX round 5 — повторний аудит за зауваженнями користувача

Дата: 2026-10-14. Статус первинного аудиту: **лише перевірка**. Після запису цього аудиту користувач окремо дозволив виправлення; реалізацію відновлено з Luna max сабагентами. Висновки нижче описують стан до виправлень. Поточні результати перевірки будуть у `UX_ROUND5_CORRECTIONS_RESULTS.md`.

Три сабагенти `gpt-6-luna` з `max` reasoning перевірили надані скриншоти, код, попередні звіти та наявні build-артефакти. Під час цього аудиту код, CSS, залежності, тести, конфігурацію й запущений застосунок не змінювали. Нові файли містять тільки висновки та пропозиції.

Попередня заява про завершеність ітерації була передчасною. Успішні 300 unit/server-тестів і 127 Chromium-сценаріїв не покривають усіх наведених нижче UX-проблем. Це не підстава відхиляти зауваження користувача.

## Висновки щодо всіх восьми зауважень

| Зауваження | Що встановлено |
| --- | --- |
| Погане форматування Preview | Великі проміжки підтверджено скриншотами. Контейнер має `white-space: pre-wrap`, а renderer не скидає успадкування; це сильний кандидат на причину зайвих переносів між блоками. Точний DOM і computed styles конкретної картки не перевіряли. |
| Те саме в коментарях? | Renderer спільний, але оточення інше. Загальні стилі Activity застосовуються до Markdown-параграфів і списків: прибирають маркери, змінюють `li` на flex та задають `pre-wrap`. Цей конфлікт селекторів підтверджено кодом; однакову величину відступів у конкретному коментарі не встановлено. |
| Edit/Delete/Like видно, але вони вимкнені | Кнопки рендеряться незалежно від підтвердженої підтримки. Реальний backend не встановлює journal edit/delete capabilities у звичайному sync, а likes доступні лише у demo. Реальне підключення цих можливостей не завершено; це не доказ, що конкретний Redmine не може підтримувати edit/delete. |
| Відкинути зміни можна лише після конфлікту | Для назви/опису/Branch кнопки справді прив'язані до conflict flags, а не звичайного dirty стану. Вони очищають локальну чернетку; undo вже застосованої серверної зміни не реалізовано. |
| Картка відкривається довше | Знайдено нові обов'язкові запити metadata на backend, послідовне очікування detail → board на клієнті та великий lazy-модуль із редактором. Це підтверджені структурні причини додаткового очікування, але фактичні секунди й внесок кожного етапу не виміряно. |
| Групі не можна налаштувати картинку | Фото/emoji налаштування, локальне сховище й API зроблені тільки для `Person`. Для груп є типізоване призначення та загальна іконка, але немає avatar settings/API/presentation. |
| Не всі картки починають із Preview | Початковий `preview` дорівнює `!initialDirty.description`. Відновлена локальна чернетка опису автоматично відкриває editor; це виняток із заявленого Preview за замовчуванням. Наявність такої чернетки саме у показаній картці не перевіряли. |
| Замість картинки — “Preserved content — edit in source mode” | Це реалізований нами source-preservation placeholder. Наявні зображення навмисно перетворюються на недоступні для візуального редагування атоми. Image extension у Tiptap не підключено; картинка у WYSIWYG не відображається. Збереження source не замінює підтримку зображення. |

## 1. Preview опису

[styles.css:240](/Users/oleksii/work/redmine-ui/src/client/styles.css:240) задає `.description-preview { white-space: pre-wrap }`. Усередині стоїть `RichContent`; його [кореневі стилі](/Users/oleksii/work/redmine-ui/src/client/components/RichContent.css:1) не задають власний `white-space`. Успадкований режим може перетворити whitespace між HTML-блоками renderer-а на додаткові порожні рядки. Звичайні відступи блоків у `RichContent.css` — 7 px, що саме по собі не пояснює масштабу проміжків на першому скриншоті.

На другому скриншоті VisualEditor показує той самий видимий текст значно компактніше. Різниця видима; точну збережену розмітку цього issue не отримували.

Пропозиція для наступної реалізації: нормальний whitespace flow для відформатованого вмісту; спеціальне збереження пробілів тільки для коду й plain/source view. Перед зміною перевірити DOM, computed styles та геометрію цитат/списків на прикладі зі скриншота.

## 2. Коментарі

Опис і коментарі використовують один `RichContent`, але [styles.css:241](/Users/oleksii/work/redmine-ui/src/client/styles.css:241) має широкі `.activity-body p/ul/li` селектори. Вони зачіпають розмітку коментаря, хоча їхній no-marker/flex вигляд потрібен службовим рядкам змін журналу.

Це окрема проблема від успадкованого `pre-wrap` у контейнері Description Preview. Пропозиція: обмежити стилі службових змін їхнім власним класом; залишити Markdown-спискам маркери, нормальне inline-розташування й вкладеність. Перевірити багаторядкові списки, цитати, inline bold/link/code та відступи саме всередині Activity.

## 3. Неактивні дії з коментарями

[Клієнтські умови](/Users/oleksii/work/redmine-ui/src/client/features/issues/IssueDialog.tsx:910) залежать від `journal.canEdit/canDelete/canLike`. [Серверна проєкція](/Users/oleksii/work/redmine-ui/src/server/app.ts:384) для real mode вимагає власний коментар і підтверджені capability flags. [Sync](/Users/oleksii/work/redmine-ui/src/server/sync/service.ts:113) цих journal flags не встановлює. Likes у цій реалізації мають підтверджений шлях лише в demo.

Отже, побудована панель і fail-closed команди — не завершена можливість редагувати/видаляти/лайкати коментарі конкретного інстансу. Водночас невідомий capability не означає доведену відсутність Redmine API. Версію й права інстансу раніше не підтвердили; нових API probes під час цього аудиту не було.

Пропозиція: окремо завершити перевірку фактичної підтримки й прав для edit/delete та plugin/API підтримки likes. Непідтримувані дії не повинні створювати враження готової функції; їх треба приховувати або пояснювати недоступність. Не вмикати невідомий API навмання й не імітувати real success локально.

## 4. Відкидання змін

[JSX кнопок](/Users/oleksii/work/redmine-ui/src/client/features/issues/IssueDialog.tsx:879) прив'язаний до `hasCardTextConflict` / `hasBranchTextConflict`. У звичайному dirty стані є Save, але немає симетричного discard для назви/опису/Branch. Конфлікт може бути помічений також при отриманні свіжих даних; код не обмежує його тільки submit.

[discardTextDrafts](/Users/oleksii/work/redmine-ui/src/client/features/issues/IssueDialog.tsx:435) повертає вибрані поля до `serverTextRef` і очищає їхні scoped drafts, включно з fallback. Це локальне відкидання чернетки, а не скасування вже збереженої зміни в Redmine. Composer має discard для непорожнього тексту, а journal editor — Cancel; тому потоки зараз непослідовні.

Пропозиція: дати scoped discard і без конфлікту, не стираючи чернетки інших полів та новіший ввід під час save. Окреме питання для наступного обговорення: чи під «збереженими змінами» мається на увазі відновлена локальна чернетка, чи потрібен також undo вже збережених серверних полів.

## 5. Відкриття картки

Підтверджені кодом етапи:

- [App.tsx:497](/Users/oleksii/work/redmine-ui/src/client/app/App.tsx:497): отримати detail, потім дочекатися board query і лише після цього дозволити показ діалогу.
- [App.tsx:23](/Users/oleksii/work/redmine-ui/src/client/app/App.tsx:23): lazy module `IssueDialog`; він статично включає `RichEditor` і `RichContent`. Composer монтує редактор одразу, навіть якщо опис у Preview.
- Наявний issue chunk: **1 058 376 байтів**, standalone gzip **323 711 байтів**. Це наявний файл `dist`, а не виміряна HTTP-відповідь; попереднього bundle для коректного порівняння немає.
- [app.ts:343](/Users/oleksii/work/redmine-ui/src/server/app.ts:343): response чекає `issueDetail`, потім `issueAssigneeOptions`.
- [adapter.ts:313](/Users/oleksii/work/redmine-ui/src/server/redmine/adapter.ts:313): новий безумовний per-open custom-field catalog GET; за порожнього label cache та сама metadata може запитуватися двічі.
- [adapter.ts:343](/Users/oleksii/work/redmine-ui/src/server/redmine/adapter.ts:343): per-open membership read та додаткові group profile GETs. Очікування відбувається навіть для best-effort enrichment, яке не є дозволом на запис.

Пропозиція: прибрати повторні metadata reads із критичного шляху, використовувати bounded cache/single-flight і паралельне завантаження, розділити показ картки та готовність другорядних каталогів. Свіжий pre-write workflow/membership guard має залишитися. Окремо профілювати холодне/повторне відкриття та старт editor chunk; проста lazy-обгортка не допоможе, якщо editor все одно монтується одразу.

**Межа доказу:** немає browser waterfall або runtime issue timings. Спроба локального health GET одного сабагента була заблокована sandbox; issue API/UI не відкривали. Тому числове уповільнення та домінуючий етап не встановлені.

## 6. Аватари груп

[Налаштування](/Users/oleksii/work/redmine-ui/src/client/features/settings/SettingsPage.tsx:513) вибирають тільки людину з `members`. Schema та `/api/people/:id/avatar` перевіряють person identity; group assignment має окремий тип, але показує загальний Users glyph.

Це відсутня інтеграція груп із локальними avatar controls. Не можна підставити group ID у person map: однакові числові IDs мають залишатися різними сутностями.

Пропозиція: окремі scoped group overrides та ключі зберігання, group selector/маршрут і фото/emoji presentation у board, Backlog, details та Assignee picker. Фото лишається локальним; role overrides і QA picker не повинні включати групи як людей.

## 7. Preview за замовчуванням

[IssueDialog.tsx:210](/Users/oleksii/work/redmine-ui/src/client/features/issues/IssueDialog.tsx:210) ініціалізує стан через `!initialDirty.description`. Якщо відновлена чернетка відрізняється від серверного опису, стартує editor.

Пропозиція: Preview при звичайному відкритті також за наявності чернетки; явний індикатор draft і перехід у редагування тільки дією користувача. Preview може показувати відновлений draft, не втрачаючи його. Стан storage конкретної скарги не досліджувався, тому це підтверджений механізм у коді, а не доказ причини саме тієї картки.

## 8. Placeholder замість зображення у WYSIWYG

[prepareRedmineSource](/Users/oleksii/work/redmine-ui/src/client/components/redmineFormatting.ts:284) за замовчуванням має `protectImages=true`. Markdown inline/reference images, Textile images і HTML fragments замінюються opaque source atoms. [RichEditor extensions](/Users/oleksii/work/redmine-ui/src/client/components/RichEditor.tsx:140) не містять Image extension. [PreservedSourceView](/Users/oleksii/work/redmine-ui/src/client/components/RichEditor.tsx:15) показує загальний `preservedMarkup` текст із `contentEditable=false`, оригінал доступний лише через title/Source.

Це спосіб зберігати розмітку без втрат, але **підтримку картинки у візуальному редакторі не реалізовано**. Здатність Preview показати зображення не означає, що editor його відображає чи дає з ним працювати. Такий самий механізм застосований до частини таблиць, task lists, reference links, Textile code/macros та інших конструкцій; фактичний scope ширший за рідкісні складні випадки.

Пропозиція: зображення мають бути видимими source-preserving image nodes із тим самим безпечним issue-scoped resolver, що й Preview, а не загальною заглушкою. Перевірити load/error/retry, attachment context і точне збереження початкової розмітки при редагуванні сусіднього тексту. Вставлення/завантаження нових вкладень — окремий API-потік; тут його підтримку не підтверджено й не реалізовували.

## Чого не покрила попередня перевірка

Тести перевіряли наявність Markdown-вузлів і збереження source, але не геометрію довгих цитат/списків у фактичному CSS оточенні. Короткі demo captures не відтворювали наданий довгий вміст. Disabled capabilities перевірялися як очікувана поведінка, без завершеної підтримки real journal API. Групи перевірялися для призначення та колізії IDs, але не avatar settings. Source-preservation для images перевіряло збереження тексту, а не наявність картинки у WYSIWYG. Не було performance budget і перевірки кількості per-open metadata requests.

Ці прогалини мають увійти до наступних критеріїв приймання. На момент аудиту пропозиції не застосовували. Наступне доручення користувача дозволило реалізацію.

## Детальні звіти сабагентів

- [Форматування, WYSIWYG images і клієнтське завантаження](UX_ROUND5_CORRECTIONS_FORMAT.md).
- [Дії з коментарями, drafts і початковий Preview](UX_ROUND5_CORRECTIONS_ISSUE.md).
- [Аватари груп і backend-запити](UX_ROUND5_CORRECTIONS_GROUPS_BACKEND.md).
