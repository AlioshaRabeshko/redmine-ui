# UX round 5 — паритет Preview і Visual Edit

Дата: 2026-10-14.

## Зміни

Опис у Preview і canvas візуального редактора тепер використовує спільний `.formatted-prose` stylesheet. Для обох режимів задано однакові 13 px і line-height 1.55, відступи абзаців, списків і цитат, рівні заголовків, горизонтальний розділювач, inline code та fenced code. Для вкладеного списку відступ зверху становить 8 px: це збігається з 8 px нижнього margin абзацу, який передує nested list у ProseMirror, і не дає накопичитися однопіксельному зсуву в наступних блоках. Обидва поля мають внутрішні відступи 10×12 px. Preview використовує `white-space: normal`, щоб відступи між HTML-блоками не ставали порожніми рядками. Корінь ProseMirror зберігає власний `break-spaces` для каретки та пробілів під час вводу; його не примусово перезаписуємо на normal. Code block використовує `pre-wrap` в обох режимах; `code` має `min-width: max-content`, щоб зберегти горизонтальний прокрутний вміст для довгих рядків. Геометрія видимих блоків порівнюється строго.

Контейнер Preview більше не має сірого `surface-alt` фону чи зайвих 15 px відступів. Він прозорий, має ту саму тонку рамку й заокруглення, що й editor canvas. Activity лишається компактним: RichContent для журналу має 12 px при тій самій пропорції line-height 1.55. Renderer-specific підтримка таблиць, безпечних зображень і їхнього retry збережена.

## Перевірка

Додано `e2e/round5-preview-parity.spec.ts`. Він створює лише demo issue з українськими абзацами, цитатою, вкладеним маркованим і нумерованим списком, горизонтальною лінією та code block; відкриває Preview і Visual Edit та порівнює computed typography, margins/padding, текст структурних блоків і relative bounding boxes. На cold navigation тест також перевіряє, що немає запиту `RichEditor-*`; після Edit очікує такий chunk-запит без часового порога. Для світлої й темної тем тест перевіряє прозорий Preview, modal color = `--surface`, modal color ≠ `--surface-alt` через probe у scope самої модалки (fixture не зобов'язаний мати footer), шрифт та відступи. Скриншоти тест приєднує до Playwright результату; QA має зберегти фінальні captures у стабільному каталозі після повторного проходу.

`npm run typecheck` пройшов. `npx vitest run src/client/components/RichContent.test.tsx src/client/components/redmineFormatting.test.ts` пройшов: 30 тестів у двох файлах. `git diff --check` чистий.

Build і сервер не запускалися: інтеграційний QA gate належить root. QA виявив однопіксельну різницю в nested list, причина виправлена спільним 8 px відступом; parity повторно перевіряється QA.

## Фінальна перевірка та розгортання

Після уточнення спільного відступу вкладених списків до 8px та `pre-wrap` для коду сувора геометрична перевірка Preview/Edit пройшла без збільшення допуску. Фінальні 20/20 цільових Chrome-сценаріїв, включно зі світлою/темною поверхнями та Activity, успішні. Primary переглянув парні PNG: [Preview](assets/ux-round5-preview-parity-light.png), [Visual Edit](assets/ux-round5-preview-parity-visual-edit.png); [темна тема](assets/ux-round5-preview-parity-dark.png) також перевірена сценарієм. Вкладені списки, заголовки, цитати, розділювач і код мають однакову відносну геометрію.

Зміни розгорнуто на localhost:3010, контейнер healthy, Redmine connected=true, локальний том збережено. Для відкритої вкладки потрібне оновлення сторінки. Реальні лайки й їх скасування пропущено за остаточним рішенням користувача. Деталі: `UX_ROUND5_LIKES_PREVIEW_QA.md` та `UX_ROUND5_PREVIEW_DEPLOY.md`.
