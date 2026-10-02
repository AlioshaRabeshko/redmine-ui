import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BoardData, Bootstrap, CommandResult } from '../src/shared/types.js';

async function choose(page: Page, scope: Page | Locator, label: string, value: string) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.picker-popover').last().locator(`[role=option][data-value="${value}"]`).click();
}

test('board opens a card and preserves keyboard navigation', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  const card = page.locator('[data-testid^="issue-card-"]').first();
  await card.click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await page.keyboard.press('b');
  await expect(page.getByTestId('project-picker')).toBeVisible();
});

test('creation fills branch from the actual issue ID and survives refresh', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByTestId('new-issue').click();
  await expect(page.getByTestId('issue-title')).toBeFocused();
  await page.getByTestId('issue-title').fill('Browser verified branch');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().method() === 'POST');
  await page.getByTestId('issue-submit').click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const result = await response.json() as CommandResult;
  expect(result.issue?.branch).toBe(`${result.issue?.id}-browser-verified-branch`);
  const detail = await (await request.get(`/api/issues/${result.issue!.id}`)).json();
  expect(detail.issue.subject).toBe('Browser verified branch');
  await page.reload();
  await expect(page.getByTestId(`issue-card-${result.issue!.id}`)).toBeVisible();
});

test('dragging a card invokes the real status command, not a local visual reorder', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const todo = boot.statuses.find(s => s.key === 'todo')!;
  const review = boot.statuses.find(s => s.key === 'review')!;
  const created = await (await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0].id,
    input: { subject: 'Drag verified task', statusId: todo.id },
  } })).json() as CommandResult;
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Пошук', exact: true }).fill('Drag verified task');
  const card = page.getByTestId(`issue-card-${created.issue!.id}`);
  const target = page.getByTestId(`lane-status:${review.id}`);
  await expect(card).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 15, from!.y + from!.height / 2, { steps: 5 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + Math.min(130, to!.height / 2), { steps: 20 });
  await page.mouse.up();
  await expect.poll(async () => {
    const detail = await (await request.get(`/api/issues/${created.issue!.id}`)).json();
    return detail.issue.statusId;
  }).toBe(review.id);
});

test('read-only connection disables remote actions without hiding the board', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const boot = await response.json() as Bootstrap;
    await route.fulfill({ json: { ...boot, mode: 'redmine', readOnly: true, capabilities: { ...boot.capabilities, canWrite: false } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('new-issue')).toBeDisabled();
  await page.locator('[data-testid^="issue-card-"]').first().click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
});

test('language and appearance preferences survive reload', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const changed = { ...boot.settings, locale: 'pl', theme: 'dark', palette: 'violet' };
  expect((await request.put('/api/settings', { data: changed })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'violet');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
  await request.put('/api/settings', { data: { ...changed, locale: 'uk', theme: 'light', palette: 'blue' } });
});

test('opening a notification selects its project, focuses its comment and archives only that event', async ({ page, request }) => {
  const notifications = await (await request.get('/api/notifications')).json();
  const notification = notifications.find((item: { journalId?: number }) => item.journalId === 9003);
  expect(notification).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml/);
  await page.locator('.nav-item').filter({ hasText: 'Вхідні' }).click();
  await page.locator('.notification-row').filter({ hasText: `#${notification.issueId}` }).locator('.notification-open').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator(`#journal-${notification.journalId}`)).toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/notifications')).json()).some((item: { id: string }) => item.id === notification.id)).toBe(false);
  expect(await (await request.get('/api/notifications')).json()).toHaveLength(notifications.length - 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.project-selector')).toContainText('Example Project');
  await page.getByRole('button', { name: 'Позначити все прочитаним', exact: true }).click();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
});

test('appearance controls save through the UI and system theme responds to the browser', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.locator('.nav-item').filter({ hasText: 'Налаштування' }).click();
  await page.getByTestId('theme-system').click();
  await page.getByTestId('palette-amber').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'amber');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const settings = await (await request.get('/api/settings')).json();
  expect(settings).toMatchObject({ theme: 'system', palette: 'amber' });
});

test('release planning includes Done cards and completes Deploy cards without a CI gate', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = boot.projects[0].id;
  const ids: number[] = [];
  for (const key of ['done', 'deploy']) {
    const result = await (await request.post('/api/commands', { data: { type: 'createIssue', projectId, input: { subject: `Release browser ${key}`, statusId: boot.statuses.find(status => status.key === key)!.id } } })).json() as CommandResult;
    ids.push(result.issue!.id);
  }
  const release = await (await request.post('/api/commands', { data: { type: 'createRelease', projectId, input: { name: 'Browser release', issueIds: ids } } })).json() as CommandResult;
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.locator('.nav-item').filter({ hasText: 'Релізи' }).click();
  await page.locator('.release-index-item').filter({ hasText: 'Browser release' }).click();
  await expect(page.locator('.release-issue-row')).toHaveCount(2);
  const complete = page.getByRole('button', { name: 'Завершити реліз', exact: true });
  await expect(complete).toBeEnabled();
  await complete.click();
  await expect.poll(async () => (await (await request.get(`/api/releases/${release.version!.id}`)).json()).version.status).toBe('closed');
  await expect(page.locator('.release-issue-row')).toHaveCount(2);
});

test('editing status reflects the actual QA and developer assignment after compound commands', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await (await request.post('/api/commands', { data: { type: 'createIssue', projectId: boot.projects[0].id, input: { subject: 'Modal handoff verification', statusId: boot.statuses.find(status => status.key === 'review')!.id, assignedToId: 2, developerId: 2 } } })).json() as CommandResult;
  await page.goto('/');
  await page.getByTestId(`issue-card-${issue.issue!.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await choose(page, dialog, 'Статус', String(boot.statuses.find(status => status.key === 'qa')!.id));
  await expect(dialog.locator('.assignee-avatar-option[data-person-id="3"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('.text-save-row')).not.toBeVisible();
  await choose(page, dialog, 'Статус', String(boot.statuses.find(status => status.key === 'todo')!.id));
  await expect(dialog.locator('.assignee-avatar-option[data-person-id="2"]')).toHaveAttribute('aria-pressed', 'true');
});
