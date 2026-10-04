import { expect, test } from '@playwright/test';
import type { Bootstrap, CommandResult, Notification } from '../src/shared/types.js';

test('full search finds completed content, changes project scope, and preserves Back navigation', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk' } });
  const marker = `content-search-${Date.now()}`;
  const make = async (projectId: number, subject: string) => (await (await request.post('/api/commands', { data: {
    type: 'createIssue', projectId, input: { subject, description: marker, statusId: boot.statuses.find(status => status.key === 'done')!.id },
  } })).json() as CommandResult).issue!;
  const local = await make(boot.projects[0].id, 'Completed content search');
  const other = await make(boot.projects[1].id, 'Other project content search');
  await page.goto(`/?project=${boot.projects[0].id}`);
  const input = page.getByRole('searchbox', { name: 'Пошук', exact: true });
  await input.fill(marker);
  const panel = page.getByTestId('full-search-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: new RegExp(`#${local.id}\\b`) })).toBeVisible();
  await expect(panel.getByRole('button', { name: new RegExp(`#${other.id}\\b`) })).toHaveCount(0);
  await expect(page.getByTestId(`issue-card-${local.id}`)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Усі проєкти', exact: true }).click();
  await expect(panel.getByRole('button', { name: new RegExp(`#${other.id}\\b`) })).toBeVisible();
  const searchUrl = page.url();
  await panel.getByRole('button', { name: new RegExp(`#${other.id}\\b`) }).click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('issue')).toBe(String(other.id));
  await page.goBack();
  await expect(page).toHaveURL(searchUrl);
  await expect(page.getByTestId('issue-dialog')).toHaveCount(0);
  await expect(input).toHaveValue(marker);
});

test('favicon clears after acknowledged reads, survives a failed read, and returns for a new event', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk' } });
  const board = await (await request.get(`/api/projects/${boot.projects[0].id}/board`)).json();
  const issue = board.issues[0];
  const make = (id: string): Notification => ({ id, issueId: issue.id, projectId: issue.projectId, actor: { id: 99_001, name: 'Notification audit' }, kind: 'comment', text: id, createdOn: new Date().toISOString() });
  let events = [make('favicon-event-1'), make('favicon-event-2')];
  let fail = true;
  await page.route('**/api/notifications', route => route.fulfill({ json: events }));
  await page.route('**/api/notifications/read', async route => {
    if (fail) { await route.fulfill({ status: 500, json: { code: 'ERROR', message: 'Read rejected' } }); return; }
    const ids = route.request().postDataJSON().ids as string[];
    events = events.filter(event => !ids.includes(event.id));
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?project=${boot.projects[0].id}&tab=inbox`);
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('data-unread', '2');
  const row = page.locator('.notification-row').filter({ hasText: 'favicon-event-1' });
  await row.getByRole('button', { name: 'Прочитати', exact: true }).click();
  await expect(page.locator('.toast')).toBeVisible();
  await expect(icon).toHaveAttribute('data-unread', '2');
  fail = false;
  await row.getByRole('button', { name: 'Прочитати', exact: true }).click();
  await expect(icon).toHaveAttribute('data-unread', '1');
  await page.locator('.notification-row').filter({ hasText: 'favicon-event-2' }).locator('.notification-open').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(icon).toHaveAttribute('data-unread', '0');
  expect(decodeURIComponent(await icon.getAttribute('href') ?? '')).not.toContain('<text');
  events = [make('favicon-new-event')];
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    // Native visibilitychange bubbles from Document to Window, where the
    // query focus manager listens. Preserve that propagation in this fixture.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });
  await expect(icon).toHaveAttribute('data-unread', '1');
  expect(decodeURIComponent(await icon.getAttribute('href') ?? '')).toContain('>1</text>');
});

test('activity choices autosave per project and survive a reload without affecting subscriptions', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk', projectActivity: { [boot.projects[0].id]: null, [boot.projects[1].id]: null } } });
  const before = await (await request.get('/api/settings')).json();
  await page.goto(`/?project=${boot.projects[0].id}&tab=settings`);
  const activity = page.getByTestId('project-activity-settings');
  await expect(activity.getByRole('checkbox', { name: 'Зміни міток', exact: true })).not.toBeChecked();
  await activity.getByRole('checkbox', { name: 'Зміни міток', exact: true }).check();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectActivity[boot.projects[0].id]?.labels).toBe(true);
  await page.reload();
  await expect(activity.getByRole('checkbox', { name: 'Зміни міток', exact: true })).toBeChecked();
  await page.goto(`/?project=${boot.projects[1].id}&tab=settings`);
  await expect(activity.getByRole('checkbox', { name: 'Зміни міток', exact: true })).not.toBeChecked();
  expect((await (await request.get('/api/settings')).json()).subscriptions).toEqual(before.subscriptions);
  await page.goto(`/?project=${boot.projects[0].id}&tab=settings`);
  await activity.getByRole('button', { name: 'Відновити стандартні', exact: true }).click();
  await expect(activity.getByRole('checkbox', { name: 'Зміни міток', exact: true })).not.toBeChecked();
});

test('search ignores stale responses, paginates, and recovers from an API error', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk' } });
  let releaseOld: (() => void) | undefined;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  let fail = true;
  await page.route('**/api/search?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const query = params.get('q');
    const offset = Number(params.get('offset') ?? 0);
    if (query === 'old-search') {
      await oldGate;
      await route.fulfill({ json: { results: [{ id: 701, title: 'Stale result', description: '' }], total: 1, offset: 0, limit: 20 } }).catch(() => undefined);
      return;
    }
    if (query === 'error-search' && fail) {
      await route.fulfill({ status: 503, json: { code: 'REDMINE_REQUEST_FAILED', message: 'Unavailable' } });
      return;
    }
    const results = Array.from({ length: offset === 0 ? 20 : 2 }, (_, index) => ({ id: 800 + offset + index, title: `Latest result ${offset + index + 1}`, description: 'Matched description', projectId: boot.projects[0].id }));
    await route.fulfill({ json: { results, total: 22, offset, limit: 20 } });
  });
  await page.goto(`/?project=${boot.projects[0].id}`);
  const input = page.getByRole('searchbox', { name: 'Пошук', exact: true });
  const oldRequest = page.waitForRequest(request => request.url().includes('/api/search?') && new URL(request.url()).searchParams.get('q') === 'old-search');
  await input.fill('old-search');
  await oldRequest;
  await input.fill('latest-search');
  const panel = page.getByTestId('full-search-panel');
  await expect(panel.getByRole('button', { name: /Latest result 1\b/ })).toBeVisible();
  releaseOld?.();
  await expect(panel.getByRole('button', { name: /Stale result/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Наступні результати', exact: true }).click();
  await expect(panel.getByRole('button', { name: /Latest result 21\b/ })).toBeVisible();
  await expect(panel.locator('.search-result')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Попередні результати', exact: true }).click();
  await expect(panel.locator('.search-result')).toHaveCount(20);
  await input.fill('error-search');
  await expect(panel.getByRole('alert')).toBeVisible();
  fail = false;
  await panel.getByRole('button', { name: 'Спробувати ще', exact: true }).click();
  await expect(panel.locator('.search-result')).toHaveCount(20);
  await expect(panel.getByRole('alert')).toHaveCount(0);
});
