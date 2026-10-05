# Приймання третього UX-раунду

Це план перевірки, а не заява про проходження. Реалізація авторизована 2026-10-05; усі зміни Redmine задач/коментарів/релізів перевіряти лише в isolated demo/mocks із порожнім токеном та окремою SQLite. Реальний preview — GET/HEAD, збережений read state не змінювати аудитом. Root може явно змінити лише локальний sync interval на 10 s при оновленні preview згідно з дорученням користувача.

## Обов’язкові сценарії

| Сценарій | Критерій |
| --- | --- |
| Inbox header / expanded groups | ID + subject; одна/кілька подій видимі одразу, newest-first без дублювання preview. Сам показ не читає події. |
| Людські зміни | status/assignee/Labels/CI names з правильних project catalogs у нових та legacy notifications; невідоме не вгадується, technical IDs не є основним текстом. |
| Event preferences | assigned-to-me також comments-only; mixed journal показує тільки дозволені частини. Missing preferences → defaults, explicit empty → no selected types; board disabled не скасовує assigned eligibility. Власні дії приховані. |
| Legacy read state | Проєкція/локальне збагачення не переписує IDs/readAt, не replay-ить remote history та не архівує приховані події. Якщо current mask приховує стару подію, при поверненні типу вона лишається unread. |
| Board badge | Count тільки доступних непрочитаних подій issue; після exact read/group read/new event узгоджений із favicon. Badge відкриває найстарішу непрочитану подію та scroll target; звичайний open не читає групу. |
| Missing target | Видалений/недоступний journal не читається як успішно відвіданий; issue можна відкрити з повідомленням та explicit read лишається доступним. |
| Unread filter | Поєднання Q/labels/other filters, URL/direct reload/Back/Forward, saved view round-trip; archive не рахується. Dialog не закривається, коли underlying card зникає; focus fallback після close. |
| Live updates | Sync stream оновлює board/counters без reload; reconnect/focus/fallback після втрати stream; без fetch storm, dirty drafts і scroll не губляться. Default10 s, explicit custom interval зберігається, worker no-overlap/backoff. |
| Buffered Activity | Incoming new IDs показуються кнопкою, не стрибає читання; own comment видимий одразу, чужий identical notes не видається за own; exact permalink target розкривається. Apply не стирає drafts. |
| Compact sticky issue | Sticky type+ID+title/close, довгі назви wrap; toolbar/footer прибрані, copy/open меню та shortcuts доступні. Header не закриває target; Escape/focus/nested modal працюють. |
| Composer/Activity/fonts | Composer перед подіями; Activity/category bar компактний із wrap; +1 px опис/comment preview/edit, інша compact typography без збільшення. |
| Labels / due date | Multi tiles + keyboard, швидкі зміни/rollback/readonly/empty catalog/current values; Due date під Labels, explicit save зберігає саме його, включно з focused Cmd/Ctrl+S. |
| Avatars | Board 30/20 px, пріоритет assignedsize/roleframes збережений; initials мають stable personcolor між проєктами/reload, читабельність light/dark; photo/emoji/reset/failed upload регресії. |
| Settings viewport | При wheel у довгому Settings весь app/sidebar/topbar не виїжджає; потрібні controls доступні через внутрішній scroll, немає body overflow. Desktop 1280×720 та ширший viewport. |
| Regressions | Повний наявний unit/server/Chrome suite після адаптації intentional layout changes; navigation, releases, comment actions, drafts, palettes/i18n та readonly transport guards. Assertions не послаблювати для приховування source bugs. |

## Процедура

Після SOURCE_READY усіх трьох напрямів — один build/typecheck, повний unit/server та Chrome gate. Окремий незалежний Luna проводить ручний desktop browser audit і записує відтворювані нові знахідки та межі. Після source fixes повторювати доречні regression-перевірки; весь suite повторювати за матеріальних інтеграційних змін. Лише після успішного gate root оновлює локальний Docker зі збереженням volume, підтверджує real read-only й комітить результат.

Native trackpad/clipboard permissions і мобільний UX не прирівнювати до синтетичного/desktop покриття. Фактичні результати додаються після виконання.
