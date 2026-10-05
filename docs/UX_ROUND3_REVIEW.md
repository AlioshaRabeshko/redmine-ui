# Незалежне статичне рев’ю UX-раунду 3

Дата: 2026-10-05. Перевірено source notifications, board/App, IssueDialog, draft/write path, LabelsTiles, Settings invalidation та modal focus. Код не змінювався; цей звіт і `UX_ROUND3_BROWSER.md` — єдині створені мною файли.

## Результати читання коду

| Ділянка | Статичний висновок |
| --- | --- |
| Inbox projection і grouping | Проєкція зберігає event IDs та read state; group header використовує issue ID і cached/fallback subject. Renderer локалізує відомі поля через project catalogs, для невідомих значень не вигадує назви. Перевірено раніше окремим source review; поточне читання не виявило регресії. |
| Event masks | Missing preferences і явний порожній набір обробляються окремо; assigned-to-me проходить той самий event mask, mixed journal фільтрує видимі частини. Це статичний висновок, не повна API перевірка. |
| Board unread path | Unread badge пов’язаний із доступними unread подіями й переходить до конкретного найстарішого unread journal. Точний target позначається прочитаним після підтвердження visible journal, а звичайне відкриття картки не викликає mass-read. |
| Notification open/read | Відкриття скасовується при зміні URL/sequence, перевіряє наявність journal до навігації, повторно використовує одноразово prefetched detail і підтверджує точний issue/journal перед read: `src/client/app/App.tsx:676`. |
| Live invalidation | Sync/message інвалідує board, unread notifications і поточний issue; settings SSE інвалідує bootstrap та notifications. Локальний subscriptions PATCH також інвалідує notifications: `src/client/app/App.tsx:244`, `src/client/app/App.tsx:262`, `src/client/app/App.tsx:458`. |
| Activity buffer | `knownIds` включає як видимі, так і вже buffered journals; власна нова подія звіряється з автором, текстом, часом і snapshot known IDs: `src/client/features/issues/IssueDialog.tsx:280`. Явний apply переносить focus на заголовок Activity без scroll; це не запускається пасивним refresh: `src/client/features/issues/IssueDialog.tsx:661`. Постійний slot має 37px, а вертикальні відступи banner зменшені до 2px, щоб він уміщався в зарезервований простір: `src/client/styles.css:322`. |
| Коментарні drafts | Успішний send очищає draft тільки якщо текст у поточному composer досі дорівнює відправленому; інакше збережений новіший текст лишається. Cross-tab listener відновлює непорожній current draft після кожного remote remove, включно з повторним clear, чий `oldValue` збігається з текстом іншої вкладки: `src/client/features/issues/IssueDialog.tsx:332`. Це відповідає локальній події `storage`, що приходить лише іншим вкладкам. У `e2e/round3-issue.spec.ts` додано двовкладковий regression з повторним відкриттям; результат виконання очікується від QA. |
| Due date / Labels | Due Date має `form` association з текстовою формою і входить до того самого explicit save path. LabelsTiles зливає каталог із current values, підтримує keyboard movement і зберігає значення поза каталогом, щоб його можна було зняти: `src/client/features/issues/LabelsTiles.tsx:24`. |
| Modal focus | При закритті зберігається opener; якщо він від'єднався, focus переходить на board fallback або `.content-scroll` із `tabIndex=-1`: `src/client/components/ui.tsx:116`. |

## Підсумок

Під час останнього source reread нових дефектів не знайшов. QA визначив причину cross-tab draft loss: після першого відновлення draft повторний `removeItem` від іншої вкладки мав `oldValue`, рівний цьому draft, і попередня рівність-перевірка пропускала відновлення. Вона прибрана; поточний listener зберігає непорожній текст кожної іншої вкладки. Banner displacement та BODY focus виправлені source-level: 37px slot тепер вміщує banner і apply переводить focus на Activity heading. Root повідомив про final `BUILD_OK` та 180/180 unit/server checks; три targeted regressions ще виконуються, а full Chrome run на 92 cases має стартувати після них. Ці запуски не виконував особисто. У браузері після final rebuild не повторював. Деталі наведені в `UX_ROUND3_BROWSER.md`.

Це не звіт про проходження автоматичних тестів. Root повідомив про попередній `BUILD_OK`; цей рев’юер не запускав typecheck, build, тести чи git-команди. Реальний Redmine, `.env`, токени та зовнішні сервіси не читалися й не використовувалися.
