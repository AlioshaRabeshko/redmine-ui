import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';

async function bootstrap(request: APIRequestContext) {
  await request.patch('/api/settings', { data: { locale: 'uk', theme: 'light', palette: 'blue' } });
  return await (await request.get('/api/bootstrap')).json() as Bootstrap;
}
async function create(request: APIRequestContext, boot: Bootstrap, subject: string, input: Record<string, unknown> = {}) {
  const response = await request.post('/api/commands', { data: { type: 'createIssue', projectId: boot.projects[0].id, input: { subject, statusId: boot.statuses.find(status => status.key === 'todo')!.id, ...input } } });
  expect(response.ok()).toBe(true);
  const result = await response.json() as CommandResult;
  expect(result.operation.status).toBe('done');
  return result.issue!;
}
async function start(page: Page, boot: Bootstrap) {
  await page.addInitScript(id => localStorage.setItem('redmine-workspace:project', String(id)), boot.projects[0].id);
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
}
async function choose(page: Page, scope: Page | Locator, label: string, value: string) {
  const tiles = scope.getByRole('radiogroup', { name: label, exact: true });
  if (await tiles.count()) { await tiles.locator(`[role=radio][data-value="${value}"]`).click(); return; }
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.picker-popover').last().locator(`[role=option][data-value="${value}"]`).click();
}
async function detail(request: APIRequestContext, id: number) {
  return (await (await request.get(`/api/issues/${id}`)).json() as IssueDetail).issue;
}

test('column creation preselects status or roadmap over old property drafts and keeps text drafts', async ({ page, request }) => {
  const boot = await bootstrap(request);
  await start(page, boot);
  const lanes = page.locator('.board-lane');
  await expect(page.locator('.lane-create')).toHaveCount(await lanes.count());
  const dialog = page.getByTestId('issue-dialog');
  await page.getByTestId('lane-version:100').locator('.lane-create').click();
  await expect(dialog.getByRole('combobox', { name: 'Реліз', exact: true })).toContainText('NEXT');
  await dialog.getByTestId('issue-title').fill('Draft carried between columns');
  await dialog.getByTestId('issue-description').fill('Keep this text when another column is chosen');
  await choose(page, dialog, 'Статус', String(boot.statuses.find(status => status.key === 'qa')!.id));
  await page.keyboard.press('Escape');
  for (const key of ['suspended', 'todo', 'progress', 'review', 'qa', 'deploy']) {
    const status = boot.statuses.find(entry => entry.key === key)!;
    await page.getByTestId(`lane-status:${status.id}`).locator('.lane-create').click();
    await expect(dialog.getByTestId('issue-title')).toBeFocused();
    await expect(dialog.getByRole('combobox', { name: 'Статус', exact: true })).toContainText(status.name);
    await expect(dialog.getByRole('combobox', { name: 'Реліз', exact: true })).toContainText('Без релізу');
    await expect(dialog.getByTestId('issue-title')).toHaveValue('Draft carried between columns');
    await expect(dialog.getByTestId('issue-description')).toHaveValue('Keep this text when another column is chosen');
    await page.keyboard.press('Escape');
  }
  const review = boot.statuses.find(status => status.key === 'review')!;
  await page.getByTestId(`lane-status:${review.id}`).locator('.lane-create').click();
  await dialog.getByTestId('issue-title').fill('UX issue created from Review column');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().method() === 'POST');
  await page.keyboard.press('Meta+s');
  const result = await (await saved).json() as CommandResult;
  expect(result.issue).toMatchObject({ statusId: review.id });
  expect(result.issue!.fixedVersionId).toBeUndefined();
  await expect(page.getByTestId(`lane-status:${review.id}`).getByTestId(`issue-card-${result.issue!.id}`)).toBeVisible();
  await page.getByTestId('lane-version:100').locator('.lane-create').click();
  await expect(dialog.getByRole('combobox', { name: 'Статус', exact: true })).toContainText('To Do');
  await expect(dialog.getByRole('combobox', { name: 'Реліз', exact: true })).toContainText('NEXT');
  await dialog.getByTestId('issue-title').fill('UX issue created from NEXT column');
  const roadmapSave = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().method() === 'POST');
  await dialog.getByTestId('issue-submit').click();
  const roadmapResult = await (await roadmapSave).json() as CommandResult;
  expect(roadmapResult.issue).toMatchObject({ statusId: boot.statuses.find(status => status.key === 'todo')!.id, fixedVersionId: 100 });
  await expect(page.getByTestId(`lane-status:${roadmapResult.issue!.statusId}`).getByTestId(`issue-card-${roadmapResult.issue!.id}`)).toBeVisible();
  await expect(page.getByTestId(`issue-card-${roadmapResult.issue!.id}`)).toContainText('NEXT');
  await expect(page.getByTestId('lane-version:100').getByTestId(`issue-card-${roadmapResult.issue!.id}`)).toHaveCount(0);
  await page.getByTestId('lane-version:100').locator('.lane-create').click();
  await dialog.getByTestId('issue-title').fill('Draft for the first project');
  await dialog.getByRole('button', { name: 'Скасувати', exact: true }).focus();
  await page.keyboard.press('b');
  const otherProject = boot.projects.find(project => project.id !== boot.projects[0].id)!;
  await page.getByTestId('project-picker').locator('.project-picker-option').filter({ hasText: otherProject.name }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByTestId('new-issue').click();
  await expect(dialog.getByTestId('issue-title')).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: 'Реліз', exact: true })).toContainText('Без релізу');
});

test('empty filtered boards retain column creation and backlog list has scoped creation', async ({ page, request }) => {
  const boot = await bootstrap(request);
  await start(page, boot);
  await page.getByRole('searchbox', { name: 'Пошук', exact: true }).fill('No matches for this lane creation check');
  await expect(page.locator('[data-testid^="issue-card-"]')).toHaveCount(0);
  await expect(page.locator('.board-empty-hint')).toBeVisible();
  const todo = boot.statuses.find(status => status.key === 'todo')!;
  await page.getByTestId(`lane-status:${todo.id}`).locator('.lane-create').click();
  await expect(page.getByTestId('issue-dialog').getByRole('combobox', { name: 'Статус', exact: true })).toContainText(todo.name);
  await page.keyboard.press('Escape');
  await page.locator('.board-view-button').filter({ hasText: /^Беклог$/ }).click();
  const backlog = boot.statuses.find(status => status.key === 'backlog')!;
  await expect(page.getByTestId('backlog-list')).toBeVisible();
  await expect(page.locator('.board-lanes')).toHaveCount(0);
  await page.getByTestId('new-issue').click();
  await expect(page.getByTestId('issue-dialog').getByRole('combobox', { name: 'Статус', exact: true })).toContainText(backlog.name);
});

test('filters open above the board; Q toggles only mine; saved filters are visible buttons', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const mine = await create(request, boot, 'UX label focus mine', { assignedToId: boot.me.id, labels: ['ux-regression'] });
  const other = await create(request, boot, 'UX label focus other', { assignedToId: 2, labels: ['ux-regression'] });
  await start(page, boot);
  const initialY = (await page.locator('.board-lanes').boundingBox())!.y;
  await page.locator('.filter-toggle').click();
  const filters = page.locator('.board-filter-popover');
  await expect(filters).toBeVisible();
  expect((await page.locator('.board-lanes').boundingBox())!.y).toBe(initialY);
  await choose(page, filters, 'Мітки', 'ux-regression');
  await page.keyboard.press('Escape'); // close nested multiselect, keep filter overlay
  await expect(filters).toBeVisible();
  await filters.getByRole('combobox', { name: 'Статус', exact: true }).click();
  const statuses = page.locator('.picker-popover').last();
  for (const key of ['todo', 'review']) {
    const option = statuses.locator(`[role=option][data-value="${boot.statuses.find(status => status.key === key)!.id}"]`);
    await option.click();
    await expect(option).toHaveAttribute('aria-selected', 'true');
  }
  await page.keyboard.press('Escape');
  await expect(filters.getByRole('combobox', { name: 'Статус', exact: true })).toContainText('To Do, Review');
  await expect(page.getByTestId(`issue-card-${mine.id}`)).toBeVisible();
  await expect(page.getByTestId(`issue-card-${other.id}`)).toBeVisible();
  await filters.getByRole('button', { name: 'Зберегти фільтр', exact: true }).click();
  await filters.getByRole('textbox', { name: 'Назва фільтра', exact: true }).fill('UX test filter');
  await filters.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.saved-filter-button').filter({ hasText: 'UX test filter' })).toBeVisible();
  await page.locator('.board-view-button').filter({ hasText: /^Усі$/ }).focus();
  await page.keyboard.press('q');
  await expect(page.getByTestId(`issue-card-${mine.id}`)).toBeVisible();
  await expect(page.getByTestId(`issue-card-${other.id}`)).not.toBeVisible();
  await page.keyboard.press('q');
  await expect(page.getByTestId(`issue-card-${other.id}`)).toBeVisible();
  await expect(page.locator('.filter-chip').filter({ hasText: 'ux-regression' })).toBeVisible();
  await page.getByRole('button', { name: 'Видалити збережений фільтр: UX test filter', exact: true }).click();
});

test('URL, branch and S shortcuts use the focused card instead of the last opened card', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const first = await create(request, boot, 'UX first shortcut target');
  const second = await create(request, boot, 'UX second shortcut target');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await start(page, boot);
  await page.getByTestId(`issue-card-${first.id}`).click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId(`issue-card-${second.id}`).locator('.card-hit-area').focus();
  await page.keyboard.press('Meta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${boot.redmineUrl.replace(/\/$/, '')}/issues/${second.id}`);
  await page.keyboard.press('Meta+Shift+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(second.branch);
  await page.keyboard.press('s');
  await expect(page.locator('.quick-move-list').locator('..')).toContainText(`#${second.id}`);
  await page.keyboard.press('Escape');
});

test('property autosave preserves text/comment drafts; Cmd+S explicitly saves only edited text', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await create(request, boot, 'UX independent drafts', { description: 'Original description', assignedToId: 2 });
  const commands: Record<string, unknown>[] = [];
  page.on('request', req => { if (req.url().endsWith('/api/commands') && req.method() === 'POST') commands.push(req.postDataJSON()); });
  await start(page, boot);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await dialog.locator('.description-area').fill('My description draft');
  await dialog.locator('.comment-area').fill('My comment draft');
  const priority = boot.priorities.find(p => p.id !== issue.priorityId)!;
  await choose(page, dialog, 'Пріоритет', String(priority.id));
  await expect.poll(async () => (await detail(request, issue.id)).priorityId).toBe(priority.id);
  expect((await detail(request, issue.id)).description).toBe('Original description');
  expect(commands).toHaveLength(1);
  expect(commands[0].input).toMatchObject({ priorityId: priority.id });
  expect(Object.keys(commands[0].input as object).filter(key => key !== 'expectedUpdatedOn')).toEqual(['priorityId']);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByTestId(`issue-card-${issue.id}`).click();
  await expect(dialog.locator('.description-area')).toHaveValue('My description draft');
  await expect(dialog.locator('.comment-area')).toHaveValue('My comment draft');
  await dialog.locator('.description-area').focus();
  await page.keyboard.press('Meta+s');
  await expect.poll(async () => (await detail(request, issue.id)).description).toBe('My description draft');
  await expect(dialog.locator('.text-save-row')).not.toBeVisible();
  expect(commands.filter(command => command.type === 'comment')).toHaveLength(0);
  await expect(dialog.locator('.comment-area')).toHaveValue('My comment draft');
  expect(commands).toHaveLength(2);
});

test('reopening a cached card after an outside status change cannot revert that change', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await create(request, boot, 'UX cached issue status');
  await start(page, boot);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  const review = boot.statuses.find(status => status.key === 'review')!;
  await request.post('/api/commands', { data: { type: 'moveIssue', issueId: issue.id, input: { statusId: review.id } } });
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog.getByRole('combobox', { name: 'Статус', exact: true })).toContainText(review.name);
  await dialog.locator('.description-area').fill('Save text after status change');
  await page.keyboard.press('Meta+s');
  await expect.poll(async () => (await detail(request, issue.id)).description).toBe('Save text after status change');
  expect((await detail(request, issue.id)).statusId).toBe(review.id);
});

test('failed property write shows an inline error, restores confirmed value and keeps description draft', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await create(request, boot, 'UX failed property write');
  await start(page, boot);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await dialog.locator('.description-area').fill('Draft survives error');
  await page.route('**/api/commands', route => route.fulfill({ status: 503, json: { code: 'CONNECTION_FAILED', message: 'Test unavailable' } }));
  await choose(page, dialog, 'Пріоритет', String(boot.priorities.find(p => p.id !== issue.priorityId)!.id));
  await expect(dialog.locator('.field-save-error')).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: 'Пріоритет', exact: true }).locator(`[data-value="${issue.priorityId}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('.description-area')).toHaveValue('Draft survives error');
  expect((await detail(request, issue.id)).description).toBe('');
});

test('successful people choices rise in the list with role avatars', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await create(request, boot, 'UX people recommendation');
  await start(page, boot);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await choose(page, dialog, 'Виконавець', '2');
  await expect.poll(async () => (await detail(request, issue.id)).assignedToId).toBe(2);
  await expect.poll(async () => (await (await request.get(`/api/projects/${boot.projects[0].id}/board`)).json()).peopleRecommendations.assignee.includes(2)).toBe(true);
  await dialog.getByRole('combobox', { name: 'Виконавець', exact: true }).click();
  const option = page.locator('.picker-popover [role="option"][data-value="2"]');
  await expect(option).toContainText('Часто обираєте');
  await expect(option.locator('.avatar-role-developer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});

test('rapid keyboard selection keeps nested filters open and Escape closes one layer', async ({ page, request }) => {
  const boot = await bootstrap(request);
  await start(page, boot);
  await page.locator('.filter-toggle').click();
  const filters = page.locator('.board-filter-popover');
  await filters.getByRole('combobox', { name: 'Статус', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const nested = page.locator('.picker-popover').last();
  await expect(nested).toBeVisible();
  await expect(nested.locator('[role=option][aria-selected=true]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(nested).not.toBeVisible();
  await expect(filters).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(filters).not.toBeVisible();
});

test('creation uses colored priority and type tiles, suggested avatars and searchable Plus', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const initialBoard = await (await request.get(`/api/projects/${boot.projects[0].id}/board`)).json();
  expect(initialBoard.trackers).toContainEqual({ id: 2, name: 'Bug' });
  expect(initialBoard.issues.some((issue: Issue) => issue.trackerId === 2)).toBe(false);
  await start(page, boot);
  await page.getByTestId('new-issue').click();
  const dialog = page.getByTestId('issue-dialog');
  const subject = 'UX tile creation';
  await expect(dialog.getByTestId('issue-title')).toBeFocused();
  await dialog.getByTestId('issue-title').fill(subject);
  const priority = boot.priorities.at(-1)!;
  await choose(page, dialog, 'Пріоритет', String(priority.id));
  await choose(page, dialog, 'Тип', '2');
  await dialog.locator('.assignee-avatar-option[data-person-id="2"]').click();
  await expect(dialog.locator('.assignee-avatar-option[data-person-id="2"]')).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('combobox', { name: 'Виконавець', exact: true }).click();
  const menu = page.locator('.picker-popover').last();
  await menu.locator('input').fill('Example Person A');
  await menu.locator('[role=option][data-value="3"]').click();
  await expect(dialog.locator('.assignee-avatar-option[data-person-id="3"]')).toHaveAttribute('aria-pressed', 'true');
  const colors = await dialog.locator('.choice-tiles-priority .choice-tile').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  expect(new Set(colors).size).toBeGreaterThan(1);
  await page.keyboard.press('Meta+s');
  await expect(dialog).not.toBeVisible();
  const board = await (await request.get(`/api/projects/${boot.projects[0].id}/board`)).json();
  const saved = board.issues.find((issue: Issue) => issue.subject === subject) as Issue;
  expect(saved).toMatchObject({ priorityId: priority.id, trackerId: 2, trackerName: 'Bug', assignedToId: 3 });
  await page.getByTestId(`issue-card-${saved.id}`).click();
  await expect(dialog.getByRole('radiogroup', { name: 'Тип', exact: true }).locator('[data-value="2"]')).toHaveAttribute('aria-checked', 'true');
  const commands: Record<string, unknown>[] = [];
  page.on('request', req => { if (req.url().endsWith('/api/commands') && req.method() === 'POST') commands.push(req.postDataJSON()); });
  await dialog.getByRole('radiogroup', { name: 'Тип', exact: true }).locator('[data-value="2"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await detail(request, saved.id)).trackerId).toBe(1);
  expect((await detail(request, saved.id)).trackerName).toBe('Feature');
  expect(commands).toHaveLength(1);
  expect(Object.keys(commands[0].input as object).filter(key => key !== 'expectedUpdatedOn').sort()).toEqual(['trackerId', 'trackerName']);
});

test('background CI automation runs with the browser page closed', async ({ page, request }) => {
  test.setTimeout(60_000);
  const boot = await bootstrap(request);
  const review = boot.statuses.find(status => status.key === 'review')!;
  const todo = boot.statuses.find(status => status.key === 'todo')!;
  await request.patch('/api/settings', { data: { automationEnabled: true, pollIntervalSeconds: 5 } });
  const issue = await create(request, boot, 'UX background CI return', { statusId: review.id, assignedToId: 3, developerId: 2, labels: ['Build: Running'], fixedVersionId: 100 });
  await start(page, boot);
  await page.close();
  try {
    const result = await (await request.post('/api/commands', { data: { type: 'updateIssue', issueId: issue.id, input: { labels: ['Build: Failed'] } } })).json() as CommandResult;
    expect(result.operation.status).toBe('done');
    await expect.poll(async () => {
      const current = await detail(request, issue.id);
      return { statusId: current.statusId, assignedToId: current.assignedToId, fixedVersionId: current.fixedVersionId };
    }, { timeout: 45_000, intervals: [500, 1000, 2000] }).toEqual({ statusId: todo.id, assignedToId: 2, fixedVersionId: 100 });
  } finally {
    await request.patch('/api/settings', { data: { pollIntervalSeconds: boot.settings.pollIntervalSeconds } });
  }
});

test('settings autosave appearance but save shortcut drafts only explicitly and retain failed drafts', async ({ page, request }) => {
  const boot = await bootstrap(request);
  await start(page, boot);
  await page.locator('.nav-item').filter({ hasText: 'Налаштування' }).click();
  const shortcut = page.locator('.shortcut-row').filter({ has: page.locator('input.shortcut-input[value="Q"]') }).locator('.shortcut-input');
  await shortcut.fill('Alt+Q');
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).theme).toBe('dark');
  expect((await (await request.get('/api/settings')).json()).shortcuts.find((item: { id: string }) => item.id === 'mine').keys).toBe('Q');
  const mineRow = page.locator('.shortcut-row').filter({ has: page.locator('input.shortcut-input[value="Alt+Q"]') });
  await mineRow.locator('.shortcut-input').focus();
  await page.keyboard.press('Meta+s');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).shortcuts.find((item: { id: string }) => item.id === 'mine').keys).toBe('Alt+Q');
  await mineRow.locator('.shortcut-input').fill('Alt+Shift+Q');
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.shortcuts) await route.fulfill({ status: 503, json: { code: 'CONNECTION_FAILED', message: 'Test unavailable' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Зберегти шорткати', exact: true }).click();
  await expect(page.locator('.settings-page .notice-error')).toBeVisible();
  await expect(page.locator('.shortcut-input[value="Alt+Shift+Q"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Зберегти шорткати', exact: true })).toBeEnabled();
  await request.patch('/api/settings', { data: { shortcuts: boot.settings.shortcuts, theme: 'light' } });
});

test('QA clearing and restoring locally overridden roles persist correctly', async ({ page, request }) => {
  const boot = await bootstrap(request);
  await start(page, boot);
  await page.locator('.nav-item').filter({ hasText: 'Налаштування' }).click();
  const settings = page.getByTestId('settings-page');
  await choose(page, settings, 'QA за замовчуванням для проєкту', '3');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectQa[String(boot.projects[0].id)]).toBe(3);
  await settings.getByRole('combobox', { name: 'QA за замовчуванням для проєкту', exact: true }).click();
  await page.locator('.picker-popover').getByRole('button', { name: 'Очистити', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectQa[String(boot.projects[0].id)]).toBeUndefined();
  await choose(page, settings, 'Ролі для відображення', '2');
  const roleSection = settings.locator('.settings-role-overrides');
  await roleSection.getByRole('checkbox', { name: 'QA', exact: true }).check();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).personRoleOverrides[String(boot.projects[0].id)]?.['2']).toContain('qa');
  await roleSection.getByRole('button', { name: 'Відновити ролі Redmine', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).personRoleOverrides[String(boot.projects[0].id)]?.['2']).toBeUndefined();
  await request.patch('/api/settings', { data: { projectQa: boot.settings.projectQa } });
});

test('release create failure stays in the modal without an unhandled rejection', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await create(request, boot, 'UX release status badge');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await start(page, boot);
  await page.locator('.nav-item').filter({ hasText: 'Релізи' }).click();
  await page.locator('.heading-actions').getByRole('button', { name: 'Новий реліз', exact: true }).click();
  const modal = page.locator('.release-modal');
  await expect(modal.getByRole('textbox', { name: 'Назва релізу', exact: true })).toBeFocused();
  await modal.getByRole('textbox', { name: 'Назва релізу', exact: true }).fill('UX failed release');
  const issueOption = modal.locator('.assignment-option').filter({ hasText: issue.subject });
  await expect(issueOption).toContainText('To Do');
  await expect(issueOption).not.toContainText('Фактичний статус');
  await page.route('**/api/commands', route => route.fulfill({ status: 503, json: { code: 'CONNECTION_FAILED', message: 'Test unavailable' } }));
  await page.keyboard.press('Meta+s');
  await expect(modal.locator('.notice-error')).toBeVisible();
  await expect(modal.getByRole('textbox', { name: 'Назва релізу', exact: true })).toHaveValue('UX failed release');
  expect(pageErrors).toEqual([]);
});

test('clearing a release date sends null and survives reopening', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const result = await (await request.post('/api/commands', { data: { type: 'createRelease', projectId: boot.projects[0].id, input: { name: 'UX date clear', dueDate: '2026-12-12' } } })).json() as CommandResult;
  await start(page, boot);
  await page.locator('.nav-item').filter({ hasText: 'Релізи' }).click();
  await page.locator('.release-index-item').filter({ hasText: 'UX date clear' }).click();
  await page.locator('.release-detail-actions').getByRole('button', { name: 'Редагувати', exact: true }).click();
  const modal = page.locator('.release-modal');
  await modal.locator('input[type=date]').fill('');
  await page.keyboard.press('Meta+s');
  await expect(modal).not.toBeVisible();
  const current = await (await request.get(`/api/releases/${result.version!.id}`)).json();
  expect(current.version.dueDate).toBeUndefined();
  await page.locator('.release-detail-actions').getByRole('button', { name: 'Редагувати', exact: true }).click();
  await expect(page.locator('.release-modal input[type=date]')).toHaveValue('');
});

test('typing during an in-flight text save does not discard newer draft content', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await create(request, boot, 'UX text write race');
  await start(page, boot);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  const textarea = dialog.locator('.description-area');
  await textarea.fill('Submitted description');
  let releaseResponse!: () => void;
  const responseHeld = new Promise<void>(resolve => { releaseResponse = resolve; });
  let caughtRequest!: () => void;
  const requestCaught = new Promise<void>(resolve => { caughtRequest = resolve; });
  await page.route('**/api/commands', async route => {
    const response = await route.fetch();
    caughtRequest();
    await responseHeld;
    await route.fulfill({ response });
  });
  await page.keyboard.press('Meta+s');
  await requestCaught;
  await textarea.fill('Newer description typed during save');
  releaseResponse();
  await expect(dialog.locator('.text-save-row')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Зберегти зміни', exact: true })).toBeEnabled();
  await expect(textarea).toHaveValue('Newer description typed during save');
  expect((await detail(request, issue.id)).description).toBe('Submitted description');
  await page.keyboard.press('Escape');
  await page.getByTestId(`issue-card-${issue.id}`).click();
  await expect(dialog.locator('.description-area')).toHaveValue('Newer description typed during save');
});

test('all palettes keep compact text readable in light and dark themes', async ({ page, request }) => {
  const boot = await bootstrap(request);
  await start(page, boot);
  await page.getByTestId('new-issue').click();
  for (const theme of ['light', 'dark']) for (const palette of ['blue', 'violet', 'green', 'amber']) {
    const samples = await page.evaluate(({ theme, palette }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.palette = palette;
      const color = (value: string) => { const channels = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number); return value.startsWith('color(srgb ') ? channels.map(channel => channel * 255) : channels; };
      const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      return ['.issue-card h3', '.priority-mark', '.roadmap-pill', '.label-chip', '.nav-item.nav-active', '.heading-actions .button-primary', '.not-ready', '.status-review', '.choice-tile-low', '.choice-tile-normal', '.choice-tile-high', '.choice-tile-urgent', '.choice-tile-bug', '.choice-tile-feature', '.choice-tile-task'].flatMap(selector => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return [];
        const styles = getComputedStyle(element);
        let current: HTMLElement | null = element;
        let background = 'rgb(255,255,255)';
        while (current) {
          const value = getComputedStyle(current).backgroundColor;
          if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') { background = value; break; }
          current = current.parentElement;
        }
        const foregroundLight = luminance(color(styles.color)), backgroundLight = luminance(color(background));
        return [{ selector, ratio: (Math.max(foregroundLight, backgroundLight) + .05) / (Math.min(foregroundLight, backgroundLight) + .05), fontSize: parseFloat(styles.fontSize) }];
      });
    }, { theme, palette });
    for (const sample of samples) {
      expect(sample.ratio, `${theme}/${palette} ${sample.selector}`).toBeGreaterThanOrEqual(4.5);
      expect(sample.fontSize, `${theme}/${palette} ${sample.selector}`).toBeGreaterThanOrEqual(11);
    }
  }
});
