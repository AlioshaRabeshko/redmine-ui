# Незалежний огляд коду після UX-аудиту — 2026-10-04

## Висновок

Знайдено один підтверджений кодом дефект збереження чернетки: коли браузерне сховище недоступне, IssueDialog мовчки ігнорує помилку запису, але все одно показує індикатор «чернетку збережено». Після закриття картки єдина копія тексту з React state зникає. Інших нових дефектів неправильного зовнішнього запису, перезапису локального стану або втрати подій у переглянутих потоках не підтвердив.

Це code review diff після `SOURCE_READY`. Я не запускав сервер, браузер, Docker чи тести та не змінював issue, notifications, налаштування Redmine або Trello. Кодова перевірка не є ручним проходженням UI; браузерне відтворення проблеми зі сховищем залишається за QA.

## Підтверджена знахідка

**P2 — індикатор збереження чернетки неправдивий за недоступного `localStorage`.** У [IssueDialog.tsx](src/client/features/issues/IssueDialog.tsx:214) записи чернеток текстових полів ловлять помилку сховища й продовжують без повідомлення. Коментар має таку саму поведінку на рядках 223–225. Індикатор біля редактора залежить тільки від `anyTextDirty` і не перевіряє успішність запису в сховище (рядок 523).

Відтворення: у demo заблокувати `localStorage.setItem` або змусити його кидати `QuotaExceededError`; відкрити картку, змінити заголовок чи опис і побачити індикатор чернетки; закрити картку та відкрити її знову. Компонент читає поле зі сховища під час створення стану, тож зміна відсутня. Для коментаря порядок той самий, але окремого індикатора збереження немає. Це умовний сценарій браузерного сховища; UI-послідовність і відсутність обробки помилки підтверджуються кодом, фактичний браузерний запуск ще не виконано.

Мінімальне виправлення: відділити «є незбережені зміни» від «чернетку записано на диск»; показати зрозумілий статус, коли `localStorage` не прийняв запис. Щоб повторно відкрити чернетку в поточній вкладці, тримати її ще й у стані Workspace або іншому in-memory сховищі. Без доступного persistent storage не обіцяти відновлення після reload.

## Покриття кодового огляду

Статуси нижче позначають лише те, що було простежено в коді. Вони не означають проходження сценарію в браузері.

| Сценарії | Переглянуті шляхи | Кодове свідчення та межа |
| --- | --- | --- |
| Запуск, demo/real, read-only та retry | `src/client/app/App.tsx`, `src/server/config.ts`, `src/server/commands/service.ts`, `src/server/redmine/transport.ts` | UI визначає `canWrite` лише для demo; реальний transport відхиляє запити поза GET/HEAD, а команди real mode блокуються до виконання. Режими, завантаження й відмову з’єднання в UI не проходив. |
| Навігація, URL, картки зі списку та пошуку | `src/client/app/App.tsx`, `src/client/features/search/WorkspaceSearch.tsx`, `src/server/app.ts` | Потоки відкриття issue/journal і повний пошук зі scope/offset мають окремі query keys та перевіряють застарілі відкриття. Back/Forward, прямі URL та гонки мережевих відповідей браузером не перевіряв. |
| Дошка, фільтри, DnD, статус і release membership | `src/client/features/board/BoardPage.tsx`, `src/shared/domain.ts`, `src/client/app/App.tsx` | Drop в release передає лише `fixedVersionId`; drop між статусами зберігає поточний `fixedVersionId`. Статусні та release команди не запускались; фізичний drag/autoscroll не тестував. |
| Створення, редагування, коментарі й блоковане збереження | `src/client/features/issues/IssueDialog.tsx`, `src/client/app/App.tsx`, `src/client/lib/serialFieldWrite.ts` | Текстові поля й коментарі мають окремі чернетки; зміни полів серіалізуються по issue, текстове збереження відправляє лише dirty поля. Саме persistent draft-failure є знахідкою вище; помилки API й повторне відкриття без збоїв сховища не перевіряв. |
| Activity, порядок і permalink | `src/client/lib/issueActivity.ts`, `src/client/features/issues/IssueDialog.tsx`, `src/client/app/App.tsx` | Журнали сортуються за часом desc та ID desc при однаковому часі; permalink target може розкрити приховані категорії, не переписуючи preferences. Коректність скролу/фокуса в браузері не перевіряв. |
| Inbox, grouped events, unread і favicon | `src/client/lib/notificationGroups.ts`, `src/client/features/inbox/InboxPage.tsx`, `src/client/app/App.tsx`, `src/server/app.ts` | Група містить окремі event IDs; open позначає прочитаною конкретну подію, group/all actions передають тільки unread IDs пакетами до 500, favicon рахується зі списку unread. Я не змінював unread стан і не проходив події в UI. |
| Люди, ролі, фото/emoji та налаштування | `src/server/people.ts`, `src/server/settings.ts`, `src/server/db/store.ts`, `src/client/features/settings/SettingsPage.tsx`, `src/client/lib/peoplePresentation.ts` | Роль проєкту обчислюється окремо від глобального аватара; overrides перевіряють URL людини, локальний файл проходить raster/type/size перевірку. Upload/reset, SQLite restart та ізоляцію різних instance/user runtime не перевіряв. |
| Shortcuts і доступність | `src/client/app/App.tsx`, `src/client/lib/shortcuts.ts`, `src/client/components/ui.tsx` | Глобальні shortcuts пропускаються для текстових полів і popover; Mod+S іде в активну форму. Реальний фокус-трап, клавіатурний picker, clipboard permission та роботу клавіш у modal не перевіряв. У поточних переглянутих modal JSX не знайшов прихованих focusable controls, які підтвердили б дефект focus-trap. |
| Порожні/помилкові стани та persistence | Основні компоненти вище й `src/server/app.ts` | Є кодові гілки loading/error/retry та scoped SQLite settings; інтерфейсні повідомлення, refresh/restart, quota, відсутні учасники та недоступні права не тестувалися в цій перевірці. |

## Межі для підсумкового desktop-звіту

Браузерний QA має окремо зафіксувати сценарій `localStorage` failure і результат виправлення, а також реальні сценарії URL/history, колісного скролу/DnD autoscroll, filters/search, модалок і focus, read-only drafts, grouping/unread, avatar photo/emoji після reload та recovery/error states. У цьому документі жоден із них не позначений як вручну пройдений.

## Статус знахідки після виправлення — 2026-10-05

Опис P2 вище стосується коду до виправлення. `draftStorage.ts` тепер зберігає scoped draft у пам'яті поточної вкладки за відмови browser storage, а форми розрізняють durable та session-only стан. Це застосовано до issue/new issue text, comment composer, journal editor і release forms. Cleanup прибирає memory fallback та, за потреби, використовує tombstone проти відновлення stale persisted draft. Neutral read-only copy більше не заявляє, що будь-яку чернетку вже збережено.

Chrome регресія відтворила втрату тексту до зміни й підтвердила попередження та відновлення опису/коментаря після SPA close/reopen після неї. Full reload при заблокованому сховищі повертає baseline — це чесно зазначено в warning. Результати й межі: `UX_ROUND2_AUTOMATED.md`; незалежний фінальний огляд інтеграції записується в `UX_FINAL_INTEGRATION_REVIEW.md`.
