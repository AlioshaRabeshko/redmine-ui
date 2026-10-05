# Третій UX-раунд: результат інтеграції

Дата: 2026-10-05. Зміни реалізовано через три Luna max напрями; окремий Luna провів інтеграційні тести, незалежний Luna — кодове рев’ю та ручний desktop-аудит. Фінальний gate пройдено, Docker preview оновлено зі збереженням чинного SQLite volume.

## Реалізовані вимоги

| Пункти аудиту | Результат |
| --- | --- |
| 1, 3, 8 | Inbox містить ID і назву задачі; усі події групи відкриті, newest-first. Зміни status/assignee/Labels відображаються за назвами з проєктних довідників. Старі події збагачуються локально; недоступні details мають явний fallback. |
| 2, 13 | Дзвіночок і unread count на картці; спільний index для фільтра «З непрочитаними». Фільтр поєднується з іншими, підтримує URL/history і saved views. Клік відкриває найстарішу непрочитану подію; read лише після фактичного показу target. Звичайне відкриття не читає групу. |
| 4, 9, 10 | Компактний sticky header: type, ID, повна назва та close. Copy/Open у меню `⋯`; окремі toolbar та footer прибрані. |
| 5, 15 | Board avatars 30/20 px. Стабільний персональний колір initials; рольова форма, фото й emoji збережені. |
| 6 | Опис/comment preview і текстові редактори збільшені на 1 px; решта компактної типографіки незмінна. |
| 7 | Default sync 10 s, SSE оновлює активні дані без reload; reconnect/focus і резервний browser refresh. Вхідні Activity IDs зберігаються за кнопкою reveal, drafts і позиція читання лишаються. Явні custom intervals не скидаються. |
| 11, 16 | Composer над подіями; Activity title/count і project category controls в одній планці. |
| 12 | Comments-only також для assigned-to-me; у mixed journal приховані супутні вимкнені changes. Чинна маска застосовується й до старих rows без втрати unread/read state; explicit empty categories означає none. |
| 14 | Viewport shell не скролиться разом із Settings: header/sidebar нерухомі, довгі налаштування доступні у внутрішній панелі. |
| 17, 18 | Due date під Labels, із явним save та Cmd/Ctrl+S через form association. Labels — кольорові multi tiles, keyboard navigation, довгий searchable catalog і поточні значення поза каталогом. |

Відкрита картка залишається, якщо після читання останньої події зникає з unread-фільтра. Missing journal, невдале завантаження, зміна маршруту або помилка read не архівують подію.

## Додаткові знахідки рев’ю

Виправлено повернення фокуса з Inbox після зникнення прочитаного opener та подвійний GET detail при відкритті notification. Modal пропускає приховані кнопки закритого меню під час Tab. Own-comment matching виключає вже відомі buffered IDs, щоб старий коментар із тим самим actor/text не видавався за щойно надісланий. Повторний permalink може розкрити target, який уже потрапив у буфер.

Інтеграційна перевірка виявила затримку застосування notification preferences: PATCH subscriptions і settings SSE не перечитували projected Inbox, тому старий counter міг лишатися до наступного sync. Вузьке оновлення unread/archive після settings/subscription змін виправлено й перевірено, без масового invalidation усіх даних.

Незалежний браузерний аудит знайшов два дефекти buffered Activity: поява banner зсувала вже видимий journal на висоту banner, а натискання reveal видаляло focused button і лишало focus на BODY. Банер уміщується в постійний компактний slot; явний reveal компенсує фактичний DOM-зсув видимого journal і повертає focus до заголовка Activity без прокрутки. Regression перевіряє viewport anchor зі строгим допуском <1 px до/після arrival та reveal. Саме незмінний `scrollTop` не доводить стабільності читання.

Також виправлено втрату comment draft після send з іншої вкладки: активна вкладка відновлює свій непорожній unsent text на remote storage removal, включно з повторним clear. Власний successful send очищає чернетку; non-null storage writes не запускають ping-pong. Two-tab regression перевіряє збереження та close/reopen. Це bounded recovery, а не система незалежних багатоверсійних чернеток чи повного вирішення concurrent overwrite конфліктів.

## Фінальний gate і preview

Build/typecheck пройшов після останніх source guards. Vitest — **180/180 у 33 файлах** після settings/cross-tab змін; останні UI anchor/CSS зміни перевірені фінальним build, targeted **3/3** та повним Chromium **92/92**. Перший Chrome-прогін мав 84/89 через застарілі locators/fixtures; проміжний 89/92 виявив залишковий зсув banner 5.5 px. Виправлення не послаблюють anchor/focus/read assertions.

Docker image зібрано, `compose up -d --wait --no-build` оновив лише app із тим самим volume. GET smoke підтвердив health, фінальний asset `index-BK72XyDl.js` (200), mode=redmine, connected=true, readOnly=true, canWrite=false. За прямою вимогою користувача локальний poll interval встановлено на 10 s через PATCH лише локальних settings; Redmine writes не виконувалися. Preview: http://127.0.0.1:3010/. Для вже відкритої вкладки потрібен reload.

Vite лишає advisory main chunk >500 kB (578 kB / gzip 173 kB); це не помилка збірки. Mobile UX відкладено.

## Докази

- [Вимоги й остаточні рішення](UX_ROUND3.md), [план приймання](UX_ROUND3_VALIDATION.md).
- [Board/live implementation](UX_ROUND3_BOARD.md), [notifications/Inbox](UX_ROUND3_NOTIFICATIONS.md), [issue/layout](UX_ROUND3_ISSUE.md).
- [Фактичне автоматизоване покриття](UX_ROUND3_QA.md), [незалежне кодове рев’ю](UX_ROUND3_REVIEW.md), [незалежний ручний браузерний аудит](UX_ROUND3_BROWSER.md).

Ручний аудит виконувався на початковому dist у 1280×720 й знайшов додаткові дефекти; виправлення підтверджені source review та фінальними автоматизованими regressions, без приписування ручного повтору. Ширший IAB viewport, dark Settings scroll та всі native gestures вручну не підтверджені; відповідні desktop layout/contrast сценарії покриває Chromium suite. Мутаційні сценарії — isolated demo/mocks із порожнім token; реальний Redmine GET/HEAD-only. Синтетичний wheel/keyboard тест не є перевіркою всіх фізичних trackpad жестів чи native clipboard permissions.
