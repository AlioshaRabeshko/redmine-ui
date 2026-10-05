import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BoardData, Bootstrap, CommandResult, IssueDetail, Journal, Notification } from '../src/shared/types.js';

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
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('form')).toBe(false);
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
  expect(await page.locator('.lane-create').count()).toBeGreaterThan(0);
  await expect(page.locator('.lane-create:enabled')).toHaveCount(0);
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

test('changing the subscription event mask hides and restores the same unread event without archiving it', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = 10;
  const projectKey = String(projectId);
  const previousSubscription = boot.settings.subscriptions[projectKey];
  const setup = await request.patch('/api/settings', { data: {
    locale: 'uk', subscriptions: { [projectKey]: { enabled: true, events: ['comment'] } },
  } });
  expect(setup.ok()).toBe(true);

  try {
    const initialEvents = await (await request.get('/api/notifications')).json() as Notification[];
    const target = initialEvents.find((event) => event.id === 'demo-comment-9002');
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty('readAt');
    expect(initialEvents.length).toBeGreaterThan(0);
    const otherEvents = initialEvents.filter((event) => event.id !== target!.id);

    let readRequests = 0;
    page.on('request', requestEvent => {
      if (requestEvent.url().endsWith('/api/notifications/read') && requestEvent.method() === 'POST') readRequests++;
    });
    await page.goto(`/?project=${projectId}&tab=inbox`);
    await expect(page.getByTestId(`notification-${target!.id}`)).toBeVisible();
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-unread', String(initialEvents.length));

    const inboxUrl = page.url();
    await page.locator('.nav-item').filter({ hasText: 'Налаштування' }).click();
    const subscriptionCard = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Підписка на дошку', exact: true }) });
    const comments = subscriptionCard.getByRole('checkbox', { name: 'Коментарі', exact: true });
    await expect(comments).toBeChecked();
    const hiddenMask = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
    await comments.uncheck();
    expect((await hiddenMask).ok()).toBe(true);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-unread', String(otherEvents.length));
    await page.locator('.nav-item').filter({ hasText: 'Вхідні' }).click();
    await expect(page.getByTestId(`notification-${target!.id}`)).toHaveCount(0);
    for (const event of otherEvents) await expect(page.getByTestId(`notification-${event.id}`)).toBeVisible();

    await page.locator('.nav-item').filter({ hasText: 'Налаштування' }).click();
    const restoredMask = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
    await comments.check();
    expect((await restoredMask).ok()).toBe(true);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-unread', String(initialEvents.length));
    await page.locator('.nav-item').filter({ hasText: 'Вхідні' }).click();
    await expect(page.getByTestId(`notification-${target!.id}`)).toBeVisible();

    const unreadAgain = await (await request.get('/api/notifications')).json() as Notification[];
    expect(unreadAgain.find((event) => event.id === target!.id)).toMatchObject({ id: target!.id, issueId: target!.issueId });
    expect(unreadAgain.find((event) => event.id === target!.id)).not.toHaveProperty('readAt');
    const archived = await (await request.get('/api/notifications?archived=true')).json() as Notification[];
    expect(archived.some((event) => event.id === target!.id)).toBe(false);
    expect(readRequests).toBe(0);
    await expect(page).toHaveURL(/tab=inbox/);
    expect(page.url()).toBe(inboxUrl);
  } finally {
    await request.patch('/api/settings', { data: { subscriptions: { [projectKey]: previousSubscription ?? null }, locale: boot.settings.locale } });
  }
});

test('opening a notification selects its project, focuses its comment and archives only that event', async ({ page, request }) => {
  const notifications = await (await request.get('/api/notifications')).json();
  const notification = notifications.find((item: { journalId?: number }) => item.journalId === 9003);
  expect(notification).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml/);
  await page.locator('.nav-item').filter({ hasText: 'Вхідні' }).click();
  const inboxUrl = page.url();
  let readRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/notifications/read') && request.method() === 'POST') readRequests++; });
  const notificationGroup = page.getByTestId(`notification-group-${notification.issueId}`);
  await expect(notificationGroup.locator('.notification-group-toggle')).toHaveCount(0);
  await expect(notificationGroup.locator('.notification-row').first()).toBeVisible();
  await notificationGroup.locator('.notification-row').filter({ hasText: `#${notification.issueId}` }).locator('.notification-open').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator(`#journal-${notification.journalId}`)).toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/notifications')).json()).some((item: { id: string }) => item.id === notification.id)).toBe(false);
  expect(await (await request.get('/api/notifications')).json()).toHaveLength(notifications.length - 1);
  expect(new URL(page.url()).searchParams.get('journal')).toBe(String(notification.journalId));
  await page.goBack();
  await expect(page).toHaveURL(inboxUrl);
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await page.goForward();
  await expect(page.locator(`#journal-${notification.journalId}`)).toBeVisible();
  expect(readRequests).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.project-selector')).toContainText('Example Project');
  await page.getByRole('button', { name: 'Позначити все прочитаним', exact: true }).click();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-unread', '0');
  expect(decodeURIComponent(await page.locator('link[rel="icon"]').getAttribute('href') || '')).not.toContain('<text');
});

test('reading an isolated Inbox event closes to the scroll region when its opener row disappears', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const project = boot.projects[0]!;
  const created = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: project.id,
    input: { subject: `Inbox focus fallback ${Date.now()}`, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(created.ok()).toBe(true);
  const issue = (await created.json() as CommandResult).issue!;
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const journalId = 12_100_000 + issue.id;
  const actor = (await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData).members.find(person => person.id !== boot.me.id) || boot.me;
  const notes = 'Synthetic unique event for exact read and focus fallback';
  const journal: Journal = { id: journalId, user: actor, createdOn: '2026-10-05T08:30:00.000Z', notes, changes: [] };
  detail.journals = [...detail.journals, journal];
  const notification: Notification = {
    id: `journal:${journalId}`, projectId: project.id, issueId: issue.id, journalId,
    actor, kind: 'comment', text: notes, notes, eventKinds: ['comment'], createdOn: journal.createdOn,
  };
  let notificationEvents = [notification];
  let issueGets = 0;
  const readBodies: string[][] = [];

  await page.route('**/api/events', route => route.abort());
  await page.route(url => url.pathname === '/api/notifications' && url.search === '', route => route.fulfill({ json: notificationEvents }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    const ids = route.request().postDataJSON().ids as string[];
    readBodies.push(ids);
    notificationEvents = notificationEvents.filter(item => !ids.includes(item.id));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async route => {
    issueGets += 1;
    await route.fulfill({ json: detail });
  });

  await page.goto(`/?project=${project.id}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.locator('.nav-item').filter({ hasText: 'Вхідні' }).click();
  const inboxUrl = page.url();
  await expect(page.getByTestId(`notification-${notification.id}`)).toBeVisible();

  await page.getByTestId(`notification-${notification.id}`).locator('.notification-open').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator(`#journal-${journalId}`)).toBeVisible();
  await expect.poll(() => issueGets).toBe(1);
  await expect.poll(() => readBodies).toHaveLength(1);
  expect(readBodies).toEqual([[notification.id]]);
  await expect.poll(() => notificationEvents).toHaveLength(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await expect(page).toHaveURL(inboxUrl);
  await expect(page.locator('.content-scroll')).toBeFocused();
  await expect(page.getByTestId(`notification-group-${issue.id}`)).toHaveCount(0);
  expect(issueGets).toBe(1);
  expect(readBodies).toEqual([[notification.id]]);
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
