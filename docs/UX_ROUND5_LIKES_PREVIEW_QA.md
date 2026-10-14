# UX round 5 — likes і Preview/Edit parity: QA

Статус: фінальний цільовий Chrome-набір пройшов 20/20 за 37.7 с. Після спільного CSS fix Preview та Visual Edit мають однакову виміряну геометрію в світлій і темній темах. Root `white-space` контракт редактора лишається `break-spaces`; Preview використовує `normal`. Activity зберігає компактні 12px. Backend-agent повідомив про 19/19 у mocked suite; тестові мутації виконувалися тільки в demo fixture.

## Контракт перевірки

- Description Preview та Visual Edit відображають однаковий source однаковою типографікою й геометрією для абзаців, списків, цитат, заголовків, горизонтальних ліній, коду та багаторядкового тексту. Робоча поверхня Preview відповідає white/light або dark surface, а не сірої alt-поверхні.
- Preview не завантажує додатковий editor chunk; Activity зберігає компактну типографіку desktop-коментарів.
- Для real Redmine не знайдено підтвердженого API для встановлення чи зняття реакції; отже, UI не пропонує fake local like/unlike. Непідтверджена capability та read-only лишають дію недоступною без `setJournalLike` і без локальної зміни стану.

## Підготовлені браузерні сценарії

`e2e/round5-likes.spec.ts` перевіряє, що mock Redmine unsupported/read-only режими не показують like-control, не надсилають `setJournalLike` та не змінюють локальний reaction state. Demo like/unlike уже перевіряє існуючий сценарій `e2e/comments.spec.ts`; новий spec не перевіряє непідтверджений real endpoint.

`e2e/round5-preview-parity.spec.ts` порівнює computed typography, margins, paddings, list markers та relative bounds для абзаців, вкладеного й нумерованого списку, цитати, заголовків, розділювача та code block. Root `white-space` різний навмисно: редактор зберігає пробіли курсора, Preview використовує normal flow. Перші виміри знайшли nested list на 1px вищий у Visual Edit: ProseMirror має `<p>` перед nested `<ul>` із 8px нижнього margin, а Preview має inline текст і 7px верхнього margin. Shared stylesheet тепер задає 8px для nested списків та `pre-wrap` для Preview code; після rebuild геометрія пройшла строго без послаблення допуску. Parity сценарій також доводить, що Preview не завантажує `RichEditor-*` chunk, а Edit завантажує; light/dark checks підтверджують прозору рамку та `modal surface`, відмінну від `surface-alt`. Новий тест у `e2e/round3-issue.spec.ts` окремо підтверджує ці поверхні й 12px Activity.

## Безпека та межі

Browser tests використовують тільки demo fixture та Playwright mock routes. Backend real-mode API перевірки використовують лише mock HTTP transport, якщо цей контракт підготовлений backend-agent. Жоден тест не створює, редагує чи видаляє реальні Redmine/Trello ресурси; `.env`, токени, заголовки авторизації й секретні поля response не читаються та не виводяться.

Backend підтвердив, що перевірена відповідь `include=journals,reactions` не містила reaction state, а версія target Redmine не встановлена. Поточний backend контракт лишає `journalLikes=false` та відхиляє real `setJournalLike` до будь-якого Redmine GET з `UNSUPPORTED_CAPABILITY`, навіть якщо в persisted capabilities лишився `journalLikes=true`; operation записується failed, adapter і локальний reaction cache не змінюються. Mocked backend suite пройшов 19/19 за повідомленням власника; подробиці в [backend report](UX_ROUND5_LIKES.md). Користувач підтвердив, що likes можна пропустити, тому UI не додає зовнішній fallback. Реальний like/unlike недоступний за погодженим scope, а не заявлений як готовий.

Перший Chrome-набір до звуження необов'язкових likes сценаріїв завершився 21/23; один modal-class assertion було виправлено як помилку тесту, а Preview/Edit виявив реальну 1px nested-list різницю. Після CSS виправлення parity пройшов окремо 1/1 (3.2 с), а поточний цільовий набір пройшов 20/20 (37.7 с): comments 7, round3 issue 7, image/Activity geometry 3, unsupported/read-only like safety 2, Preview parity 1. Root повідомив про 19/19 у backend mocked suite. Persisted captures: [Preview, light](assets/ux-round5-preview-parity-light.png), [Visual Edit](assets/ux-round5-preview-parity-visual-edit.png), [Preview, dark](assets/ux-round5-preview-parity-dark.png), [long description geometry](assets/ux-round5-corrections-preview.png) та [long Activity](assets/ux-round5-corrections-activity.png). Структурний JSON лежить у [parity geometry evidence](assets/ux-round5-preview-parity-geometry.json) і [Activity geometry evidence](assets/ux-round5-corrections-structural-evidence.json).
