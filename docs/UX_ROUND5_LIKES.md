# Перевірка real-like для журналів

## Результат

Справжні like/unlike для коментарів у цільовому Redmine не можна безпечно виконати backend API-токеном. У real mode `journalLikes` залишається `false`, стан demo-реакцій не проєктується, а `setJournalLike` завершується з `UNSUPPORTED_CAPABILITY` до будь-якого читання чи запису в Redmine. Операція зберігається зі статусом `failed`; локальний лічильник не змінюється. Нових віддалених записів для цієї перевірки не виконували.

## Контракт upstream Redmine

Офіційний [REST Issues API](https://www.redmine.org/projects/redmine/wiki/Rest_Issues) описує `include=reactions` із Redmine 7.1.0. У відповіді реакція представлена користувачем; разом із `journals` ця опція повертає реакції журналів, а коли функцію вимкнено — даних реакцій немає. Документація не визначає REST-операцію для додавання або зняття реакції.

У поточному [upstream routes.rb](https://github.com/redmine/redmine/blob/master/config/routes.rb) є лише web-маршрути `POST /reactions` і `DELETE /reactions/:id`. [ReactionsController](https://github.com/redmine/redmine/blob/master/app/controllers/reactions_controller.rb) вимагає сесію користувача, обробляє create/destroy лише як JavaScript і повертає 404 для інших форматів. Він не оголошує API-key auth. Для unlike контролер шукає власну реакцію за її ID; цей ID не входить до описаної REST-відповіді. Отже, core дає окремий browser-session шлях, але не підтверджує придатний для цього backend сервісний контракт.

## Обмежена перевірка цільового інстансу

Backend-транспорт із наявною серверною конфігурацією виконав лише обмежені GET-запити для проєкту 52; response bodies лишалися в пам'яті. У звіті не збережено ID користувачів, задач чи журналів, тексти нотаток, заголовки авторизації або довільні поля відповіді.

- `GET /users/current.json` та обмежений `GET /issues.json?project_id=52&status_id=*&limit=3` повернули 200.
- Два свіжі detail-запити з `include=journals,reactions` повернули 200. В одному з них було три коментарі з непорожніми нотатками; поле `reactions` було відсутнє в кожному з цих журналів і на самій задачі.
- Заголовок `X-Redmine-Version` не повернувся. Відсутність reaction metadata не визначає точну версію чи налаштування функції; вона підтверджує лише те, що перевірена REST-відповідь не дала стану реакцій.
- `OPTIONS /reactions` без авторизаційних заголовків повернув 404 без `Allow`. Це не підтверджує жоден API-метод. У браузерному UI цільового Redmine видно web-посилання reaction із `data-method="post"` та `data-remote="true"`, сумісне з core session-based маршрутом.

Не виконували жодних POST, PUT або DELETE до Redmine. Рольові permissions проєкту не доводять окремої API-автентифікації чи права на реакцію.

## Захисна перевірка в коді

У real executor додано тест, який навмисно виставляє застарілий `journalLikes: true` і перевіряє, що команда все одно зберігається як невдала з `UNSUPPORTED_CAPABILITY`, не читає issue, не змінює локальні likes і не викликає зовнішній запис. Це перевіряє fail-closed поведінку лише через ізольований SQLite та mocked adapter.

Користувач підтвердив, що змінювати Redmine сервер не можна. Тому ця дія залишається недоступною в real mode: у поточного backend API-токена немає підтвердженого JSON endpoint для читання й встановлення стану реакції. Вона стане придатною для інтеграції лише після появи такого endpoint у самому інстансі; browser-session кнопка, `OPTIONS 404`, permission role чи локальний capability flag цього контракту не замінюють.

## Остаточне рішення користувача

Після перевірки користувач прямо дозволив не реалізовувати like/unlike, якщо потрібних операцій немає в API. Цю частину пропущено в погодженому scope. Плагін, інтеграцію через browser credentials, зовнішній reaction fallback чи локальну імітацію не додавали. Незалежно виправлено копіювання й цитування permalink коментаря: воно веде на підтверджений native DOM anchor `#journal-{id}-notes`.
