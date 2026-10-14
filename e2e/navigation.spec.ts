import { expect, test, type Page } from '@playwright/test';
import type { BoardData, Bootstrap } from '../src/shared/types.js';
import { editDescriptionSource, sourceEditor } from './helpers/rich-editor.js';

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
const nav = (page: Page, text: string) => page.locator('.nav-item').filter({ hasText: text });

test.beforeEach(async ({ request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  await request.patch('/api/settings', { data: { locale: 'uk' } });
});

test('sections, project picker and project selection participate in browser history', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await page.goto(`/?project=${boot.projects[0].id}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await nav(page, 'Налаштування').click();
  await expect.poll(() => param(page, 'tab')).toBe('settings');
  await nav(page, 'Релізи').click();
  await expect.poll(() => param(page, 'tab')).toBe('releases');
  await page.reload();
  await expect(page.getByTestId('releases-page')).toBeVisible();
  await page.goBack();
  await expect.poll(() => param(page, 'tab')).toBe('settings');
  await expect(page.locator('.settings-page')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('releases-page')).toBeVisible();
  await page.keyboard.press('b');
  await expect.poll(() => param(page, 'overlay')).toBe('projects');
  await page.reload();
  await expect(page.getByTestId('project-picker')).toBeVisible();
  await page.getByTestId('project-picker').getByRole('button').filter({ hasText: boot.projects[1].name }).click();
  await expect.poll(() => param(page, 'project')).toBe(String(boot.projects[1].id));
  await expect(page.getByTestId('board')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('releases-page')).toBeVisible();
  await expect(page.getByTestId('project-picker')).not.toBeVisible();
  await page.goForward();
  await expect(page.locator('.project-selector')).toContainText(boot.projects[1].name);
});

test('card URL, Back, Forward and reload restore the card and unsent text', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await page.goto(`/?project=${boot.projects[0].id}`);
  const card = page.locator('[data-testid^="issue-card-"]').first();
  await card.click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  const issueId = param(page, 'issue');
  expect(issueId).toBeTruthy();
  const description = await editDescriptionSource(page);
  await description.fill('Navigation description draft');
  const comment = await sourceEditor(page, 'comment-composer');
  await comment.fill('Navigation comment draft');
  await page.goBack();
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await expect.poll(() => param(page, 'issue')).toBeNull();
  await page.goForward();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(await editDescriptionSource(page)).toHaveValue('Navigation description draft');
  await expect(await sourceEditor(page, 'comment-composer')).toHaveValue('Navigation comment draft');
  await page.reload();
  await expect(await editDescriptionSource(page)).toHaveValue('Navigation description draft');
  await page.keyboard.press('Escape');
  await expect.poll(() => param(page, 'issue')).toBeNull();
  await page.goForward();
  await expect.poll(() => param(page, 'issue')).toBe(issueId);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
});

test('column creation URL restores defaults and drafts without submitting on history navigation', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const review = boot.statuses.find(status => status.key === 'review')!;
  let commands = 0;
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.method() === 'POST') commands++; });
  await page.goto(`/?project=${boot.projects[0].id}`);
  await page.getByTestId(`lane-status:${review.id}`).locator('.lane-create').click();
  await expect.poll(() => param(page, 'form')).toBe('new-issue');
  expect(param(page, 'status')).toBe(String(review.id));
  expect(param(page, 'roadmap')).toBe('none');
  await page.getByTestId('issue-title').fill('History creation draft');
  await (await sourceEditor(page, 'issue-description-editor')).fill('Unsent creation description');
  await page.reload();
  await expect(page.getByTestId('issue-title')).toHaveValue('History creation draft');
  await expect(page.locator('.create-issue-dialog').getByRole('combobox', { name: 'Статус', exact: true })).toContainText(review.name);
  await page.goBack();
  await expect(page.getByTestId('issue-title')).not.toBeVisible();
  await page.goForward();
  await expect(await sourceEditor(page, 'issue-description-editor')).toHaveValue('Unsent creation description');
  expect(commands).toBe(0);
});

test('release forms and assignment drafts restore through history and reload', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const board = await (await request.get(`/api/projects/${boot.projects[0].id}/board`)).json() as BoardData;
  const version = board.versions.find(version => version.status !== 'closed')!;
  let commands = 0;
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.method() === 'POST') commands++; });
  await page.goto(`/?project=${boot.projects[0].id}&tab=releases`);
  await page.locator('.heading-actions').getByRole('button', { name: 'Новий реліз', exact: true }).click();
  await expect.poll(() => param(page, 'form')).toBe('new-release');
  await page.locator('.release-form .text-input').first().fill('Release navigation draft');
  await page.reload();
  await expect(page.locator('.release-form .text-input').first()).toHaveValue('Release navigation draft');
  await page.goBack();
  await expect(page.locator('.release-modal')).not.toBeVisible();
  await page.goForward();
  await expect(page.locator('.release-form .text-input').first()).toHaveValue('Release navigation draft');
  await page.keyboard.press('Escape');
  await page.locator('.release-index-item').filter({ hasText: version.name }).click();
  await expect.poll(() => param(page, 'release')).toBe(String(version.id));
  await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await expect.poll(() => param(page, 'form')).toBe('edit-release');
  await page.locator('.release-form .text-input').first().fill('Unsent renamed release');
  await page.goBack();
  await expect(page.locator('.release-modal')).not.toBeVisible();
  await page.goForward();
  await expect(page.locator('.release-form .text-input').first()).toHaveValue('Unsent renamed release');
  await page.reload();
  await expect(page.locator('.release-form .text-input').first()).toHaveValue('Unsent renamed release');
  await page.keyboard.press('Escape');
  await page.locator('.release-detail-actions').getByRole('button', { name: 'Додати задачі', exact: true }).click();
  await expect.poll(() => param(page, 'form')).toBe('assign-release');
  const checkbox = page.locator('.assignment-option input').first();
  await checkbox.check();
  await page.goBack();
  await expect(page.locator('.release-modal')).not.toBeVisible();
  await page.goForward();
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(checkbox).toBeChecked();
  expect(commands).toBe(0);
});

test('search and assigned-to-me filters preserve meaningful history entries', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await page.goto(`/?project=${boot.projects[0].id}`);
  const search = page.getByRole('searchbox', { name: 'Пошук', exact: true });
  await search.pressSequentially('checkout');
  await expect.poll(() => param(page, 'q')).toBe('checkout');
  await search.blur();
  await page.keyboard.press('q');
  await expect.poll(() => param(page, 'mine')).toBe('1');
  await page.keyboard.press('q');
  await expect.poll(() => param(page, 'mine')).toBeNull();
  await page.goBack();
  await expect.poll(() => param(page, 'mine')).toBe('1');
  await page.goBack();
  await expect.poll(() => param(page, 'mine')).toBeNull();
  expect(param(page, 'q')).toBe('checkout');
  await page.goBack();
  await expect(search).toHaveValue('');
  await page.goForward();
  await expect(search).toHaveValue('checkout');
  await page.reload();
  await expect(search).toHaveValue('checkout');
});

test('direct issue links resolve the actual project and closing stays in the workspace', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const board = await (await request.get(`/api/projects/${boot.projects[1].id}/board`)).json() as BoardData;
  await page.goto(`/?project=${boot.projects[0].id}&issue=${board.issues[0].id}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect.poll(() => param(page, 'project')).toBe(String(boot.projects[1].id));
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await expect(page.getByTestId('board')).toBeVisible();
  expect(param(page, 'issue')).toBeNull();
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:3100');
});

test('command and status dialogs are URL-driven and history never repeats a command', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const board = await (await request.get(`/api/projects/${boot.projects[1].id}/board`)).json() as BoardData;
  let commands = 0;
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.method() === 'POST') commands++; });
  await page.goto(`/?project=${boot.projects[0].id}`);
  await page.getByTestId('board').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Control+k');
  await expect.poll(() => param(page, 'overlay')).toBe('commands');
  await page.reload();
  await expect(page.locator('.palette-modal')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.palette-modal')).not.toBeVisible();
  await page.goForward();
  await expect(page.locator('.palette-modal')).toBeVisible();
  await page.locator('.palette-list button').first().click();
  await expect(page.getByRole('searchbox', { name: 'Пошук', exact: true })).toBeFocused();
  await expect.poll(() => param(page, 'overlay')).toBeNull();
  await page.goto(`/?project=${boot.projects[0].id}&overlay=move&move=${board.issues[0].id}`);
  await expect(page.locator('.quick-move-list')).toBeVisible();
  await expect.poll(() => param(page, 'project')).toBe(String(boot.projects[1].id));
  await page.reload();
  await expect(page.locator('.quick-move-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => param(page, 'overlay')).toBeNull();
  expect(commands).toBe(0);
});

test('read-only deep-linked creation stays disabled after reload and history changes', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const boot = await response.json() as Bootstrap;
    await route.fulfill({ json: { ...boot, mode: 'redmine', readOnly: true, capabilities: { ...boot.capabilities, canWrite: false } } });
  });
  await page.goto('/?form=new-issue&status=999999&roadmap=999999');
  await page.getByTestId('issue-title').fill('Read-only navigation draft');
  await expect(page.getByTestId('issue-submit')).toBeDisabled();
  await expect.poll(() => param(page, 'status')).toBeNull();
  await expect.poll(() => param(page, 'roadmap')).toBeNull();
  await page.reload();
  await expect(page.getByTestId('issue-title')).toHaveValue('Read-only navigation draft');
  await expect(page.getByTestId('issue-submit')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeVisible();
});

test('successful creation consumes the form entry and Forward cannot resubmit it', async ({ page }) => {
  await page.goto('/?tab=settings');
  await nav(page, 'Усі').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByTestId('new-issue').click();
  await page.getByTestId('issue-title').fill('History completed creation');
  let commands = 0;
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.method() === 'POST') commands++; });
  await page.getByTestId('issue-submit').click();
  await expect(page.getByTestId('issue-title')).not.toBeVisible();
  await expect.poll(() => param(page, 'form')).toBeNull();
  await page.goBack();
  await expect.poll(() => param(page, 'tab')).toBe('settings');
  await page.goForward();
  await expect(page.getByTestId('board')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('issue-title')).not.toBeVisible();
  expect(commands).toBe(1);
});

test('repeated Escape in the same event loop closes a form only once', async ({ page }) => {
  await page.goto('/?tab=settings');
  await nav(page, 'Усі').click();
  await page.getByTestId('new-issue').click();
  await expect(page.getByTestId('issue-title')).toBeVisible();
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(page.getByTestId('issue-title')).not.toBeVisible();
  await expect(page.getByTestId('board')).toBeVisible();
  expect(param(page, 'tab')).toBeNull();
});

test('closed releases do not expose editing or assignment through a direct URL', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const board = await (await request.get(`/api/projects/${boot.projects[0].id}/board`)).json() as BoardData;
  const version = board.versions.find(version => version.status === 'closed')!;
  for (const form of ['edit-release', 'assign-release']) {
    await page.goto(`/?project=${boot.projects[0].id}&release=${version.id}&form=${form}`);
    await expect(page.getByTestId('releases-page')).toBeVisible();
    await expect.poll(() => param(page, 'form')).toBeNull();
    await expect(page.locator('.release-modal')).not.toBeVisible();
    await expect(page.locator('.release-detail-title')).toContainText(version.name);
  }
});

test('late issue response cannot reopen a card after Back, and missing links can be closed', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/issues/*', async route => { await gate; await route.continue(); });
  await page.goto('/');
  await page.locator('[data-testid^="issue-card-"]').first().click();
  await expect.poll(() => param(page, 'issue')).not.toBeNull();
  await page.goBack();
  await expect.poll(() => param(page, 'issue')).toBeNull();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await page.goto('/?issue=999999999&journal=1');
  await expect(page.locator('.modal .notice-error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeVisible();
  expect(param(page, 'issue')).toBeNull();
});
