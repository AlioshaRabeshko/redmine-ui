# Незалежний desktop browser аудит UX-раунду 3

Дата: 2026-10-05. UI відкрито в прихованому IAB через окремий локальний demo listener на `127.0.0.1:3145`, `APP_MODE=demo`, порожній `REDMINE_API_TOKEN` та тимчасову SQLite у `/private/tmp`. Зміни коментарів і due date торкнулися тільки цього demo fixture. Реальний Redmine/3010, `.env`, токен і зовнішні сервіси не використовувалися.

Браузерні спостереження нижче зроблені на dist після початкового `BUILD_OK`. Після них source отримав вузькі правки; повторного manual browser підтвердження цих трьох шляхів у цьому звіті немає. За повідомленням root, фінальний source отримав `BUILD_OK` і 180/180 unit/server checks у 33 файлах; три targeted regressions ще виконуються, а full Chrome run із 92 cases очікує на них. Автоматизовані перевірки не запускав і їх результати самостійно не верифікував.

## Фактично перевірені сценарії — viewport 1280×720

| Сценарій | Спостереження |
| --- | --- |
| Inbox | Unread count спочатку дорівнював 2; групи показували issue ID і subject, розгорнуті події були newest-first. Сам показ Inbox не змінив unread count. |
| Board unread badge | Клік по #issue-example відкрив `?project=10&issue=1001&journal=9002`; цільовий journal був видимий. Після показу exact target його badge зник, unread count зменшився з 2 до 1, друга задача лишилася unread. |
| Issue modal | На 1280×720 видимі sticky header/close, composer над Activity, labels і due date у правій панелі. На сторінці board та modal `html/body` залишилися 1280×720. Після close focus повернувся на opener-картку #issue-example, повторне відкриття працювало. |
| Labels keyboard | ArrowRight перемістив фокус з `api` на `Build: Succeeded`; Enter перемикав `aria-pressed` false→true→false. |
| Due Date | Playwright `fill()` змінив DOM value, але не викликав React dirty/save state; це інструментальна межа synthetic fill, а не підтверджений product bug. Native date segment keyboard (`20`, `10`, `2026`) встановив React value `2026-10-20`; Ctrl+S показав «Збережено», очистив dirty/draft state, після reload demo GET повернув `2026-10-20`. |
| Settings internal scroll | Wheel змінив `.content-scroll.scrollTop` з 0 на 720; `window.scrollY` лишився 0, sidebar і topbar лишилися на місці, `body` лишився 1280×720. Перевірено на світлій темі; темна тема цим аудитом не перевірялась. |
| Buffered Activity | Перша вкладка з draft і scrollTop 220.5 отримала вхідний demo comment після submit у другій вкладці. З’явився «Показати 1 нову подію»; коментар залишився схований, draft був збережений і composer лишився focused. |

## Знахідки на dist до наступних source fixes

1. **P2 — banner зміщував видиму точку читання.** До надходження події верх `#journal-9002` був на 611.4 px, після появи banner — на 665.9 px (+54.5 px), тоді як `scrollTop` лишився 220.5. У фінальному source QA знайшов ще 5.5px переповнення: slot 37px, banner 42.5px. Вертикальні padding зменшили до 2px (banner 36.5px); targeted regression лишає строгі `<1px` перевірки висоти slot і viewport top. Manual retest після цього build не робив.
2. **P2 — explicit “Show new events” втрачав focus.** Після натискання сфокусований banner button зникав і `document.activeElement` ставав `BODY`; draft лишався. Поточний source переводить focus на Activity heading лише після explicit apply; пасивний refresh focus не перехоплює. QA включив цей шлях до targeted regressions; manual retest після final build не робив.
3. **P2 — comment draft між вкладками губився.** Перша вкладка мала durable draft. Друга вкладка того самого demo issue відправила інший comment. У першій вкладці draft пережив приховане буферизоване оновлення, але після закриття та повторного відкриття modal composer був порожній. QA визначив race: другий clear віддалено видаляв щойно відновлений draft; його `oldValue` збігався з текстом першої вкладки, тому попередній guard пропускав відновлення. У поточному source guard прибрали й залишили відновлення непорожнього тексту на будь-який remote remove. QA додав regression у двох вкладках та перевірку reopen у `e2e/round3-issue.spec.ts`; три targeted regressions ще виконуються. Ручного повтору після нового build не було.

## Межі покриття

Запит `viewport.set({width:1440,height:900})` завершився без помилки, але фактичний IAB залишився 1280×720. Тому ширший viewport/body-overflow не підтверджений вручну. Не перевірялися mobile UX, темний Settings scroll, повний header long-wrap/menu keyboard trap, повний набір Labels empty/current-out-of-catalog та light/dark контрасти, real read-only transport, SSE reconnect/backoff, і destructive nested-dialog сценарії. Частину регресій перевіряє окрема автоматизація; її результати тут не приписуються ручному аудиту.

Тимчасовий demo listener зупинено, SQLite та її `-wal`/`-shm` файли видалено, дві hidden IAB tabs закриті. Ні автоматичні тести, ні повний план з `UX_ROUND3_VALIDATION.md` цим звітом не оголошуються пройденими.
