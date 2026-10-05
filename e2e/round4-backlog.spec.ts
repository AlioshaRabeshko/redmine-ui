import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail, Notification } from '../src/shared/types.js';

async function bootstrap(request: APIRequestContext): Promise<Bootstrap> {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light' } });
  const value = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(value.mode).toBe('demo');
  return value;
}

async function createBacklogIssue(request: APIRequestContext, boot: Bootstrap, subject: string, values: Record<string, unknown> = {}): Promise<Issue> {
  const response = await request.post('/api/commands', { data: { type: 'createIssue', projectId: boot.projects[0]!.id, input: {
    subject, statusId: boot.statuses.find(status => status.key === 'backlog')!.id,
    assignedToId: boot.me.id, trackerId: 1, ...values,
  } } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

async function createIssue(request: APIRequestContext, boot: Bootstrap, subject: string, statusId: number, values: Record<string, unknown> = {}): Promise<Issue> {
  const response = await request.post('/api/commands', { data: { type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, statusId, assignedToId: boot.me.id, trackerId: 1, ...values } } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

async function openBacklog(page: Page, projectId: number) {
  await page.addInitScript(id => localStorage.setItem('redmine-workspace:project', String(id)), projectId);
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.locator('.board-view-button').filter({ hasText: /^Backlog$/ }).click();
  await expect(page.getByTestId('backlog-list')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await bootstrap(request);
});

test('backlog is a compact overflow-safe list with dates, priority order, and keyboard unread action in read-only mode', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const longTitle = `Unbroken-${'x'.repeat(150)}`;
  const low = await createBacklogIssue(request, boot, 'Backlog lower priority', { priorityId: boot.priorities.find(priority => priority.rank === 2)!.id, labels: ['review-ready'], assignedToId: 2 });
  const high = await createBacklogIssue(request, boot, longTitle, {
    priorityId: boot.priorities.find(priority => priority.rank === 4)!.id,
    labels: [`long-label-${'z'.repeat(90)}`], developerId: 2, qaId: 3,
  });
  const todoId = boot.statuses.find(status => status.key === 'todo')!.id;
  let todoIssue = await createIssue(request, boot, longTitle, todoId, { dueDate: '2099-12-31' });
  await request.post('/api/commands', { data: { type: 'updateIssue', issueId: todoIssue.id, input: { dueDate: '2099-12-31' } } });
  todoIssue = (await (await request.get(`/api/issues/${todoIssue.id}`)).json() as IssueDetail).issue;
  const detail = await (await request.get(`/api/issues/${high.id}`)).json() as IssueDetail;
  const todoDetail = await (await request.get(`/api/issues/${todoIssue.id}`)).json() as IssueDetail;
  const journalId = 993_004;
  const todoJournalId = 994_004;
  detail.journals.push({ id: journalId, user: boot.me, createdOn: '2026-10-05T09:00:00.000Z', notes: 'Backlog unread event', changes: [] });
  todoDetail.journals.push({ id: todoJournalId, user: boot.me, createdOn: '2026-10-05T09:00:00.000Z', notes: 'Board unread event', changes: [] });
  const makeUnread = (issue: Issue, journalBase: number): Notification[] => Array.from({ length: 123 }, (_, index) => {
    const eventJournalId = journalBase + index;
    const createdOn = new Date(Date.parse('2026-10-05T09:00:00.000Z') + index * 1_000).toISOString();
    return { id: `journal:${eventJournalId}`, projectId: issue.projectId, issueId: issue.id, journalId: eventJournalId,
      actor: boot.me, kind: 'comment', text: `Unread event ${index + 1}`, createdOn };
  });
  let notifications: Notification[] = [...makeUnread(high, journalId), ...makeUnread(todoIssue, todoJournalId)];
  const readCalls: string[][] = [];
  let commandPosts = 0;

  await page.route(url => url.pathname === '/api/bootstrap', async route => {
    const response = await route.fetch();
    const value = await response.json() as Bootstrap;
    value.capabilities.canWrite = false;
    value.readOnly = true;
    await route.fulfill({ response, json: value });
  });
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: notifications }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    const ids = route.request().postDataJSON().ids as string[];
    readCalls.push(ids);
    notifications = notifications.filter(item => !ids.includes(item.id));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(url => url.pathname === `/api/issues/${high.id}`, route => route.fulfill({ json: detail }));
  await page.route(url => url.pathname === `/api/issues/${todoIssue.id}`, route => route.fulfill({ json: todoDetail }));
  page.on('request', requestEvent => { if (requestEvent.url().endsWith('/api/commands') && requestEvent.method() === 'POST') commandPosts++; });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(id => localStorage.setItem('redmine-workspace:project', String(id)), boot.projects[0]!.id);
  await page.goto(`/?project=${boot.projects[0]!.id}`);
  await expect(page.getByTestId('board')).toBeVisible();
  const todoCard = page.getByTestId(`issue-card-${todoIssue.id}`);
  await expect(todoCard).toBeVisible();
  await expect(todoCard.locator('h3')).toHaveCSS('overflow-wrap', 'anywhere');
  const cardSizes = await todoCard.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(cardSizes.scroll).toBeLessThanOrEqual(cardSizes.client);
  const cardBadge = page.getByTestId(`issue-unread-badge-${todoIssue.id}`);
  await expect(cardBadge).toContainText('123');
  await expect(cardBadge).toHaveCSS('background-color', 'rgb(180, 35, 53)');
  const dueChip = todoCard.locator('.due-chip');
  await expect(dueChip).toBeVisible();
  const cardPeople = await todoCard.locator('.card-people').boundingBox();
  const badgeBox = await cardBadge.boundingBox();
  const dueBox = await dueChip.boundingBox();
  expect(cardPeople).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(dueBox).not.toBeNull();
  expect(badgeBox!.x).toBeGreaterThan(cardPeople!.x);
  expect(badgeBox!.y).toBeLessThan(cardPeople!.y + cardPeople!.height);
  expect(badgeBox!.y + badgeBox!.height).toBeGreaterThan(cardPeople!.y);
  expect(dueBox!.x + dueBox!.width).toBeLessThanOrEqual(badgeBox!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  await page.locator('.board-view-button').filter({ hasText: /^Backlog$/ }).click();
  await expect(page.getByTestId('backlog-list')).toBeVisible();
  const rows = page.locator('.backlog-row');
  await expect(page.getByTestId(`backlog-row-${high.id}`)).toBeVisible();
  await expect(page.getByTestId(`backlog-row-${low.id}`)).toBeVisible();
  const ownRowOrder = await rows.evaluateAll((elements, ownIds) => elements.map(element => Number(element.getAttribute('data-issue-id'))).filter(id => ownIds.includes(id)), [high.id, low.id]);
  expect(ownRowOrder).toEqual([high.id, low.id]);
  await expect(page.locator('.board-lanes')).toHaveCount(0);
  const highRow = page.getByTestId(`backlog-row-${high.id}`);
  await expect(highRow).toContainText(longTitle);
  await expect(highRow).toContainText('Feature');
  await expect(highRow).toContainText(`#${high.id}`);
  await expect(highRow.locator('.backlog-label')).toContainText('long-label-');
  await expect(highRow.locator('.backlog-people .avatar-role-developer')).toBeVisible();
  await expect(highRow.locator('.backlog-people .avatar-role-qa')).toBeVisible();
  const createdTime = highRow.locator('time').nth(0);
  const activityTime = highRow.locator('time').nth(1);
  await expect(createdTime).toHaveAttribute('datetime', high.createdOn);
  await expect(activityTime).toHaveAttribute('datetime', high.updatedOn);
  await expect(createdTime).toHaveAttribute('title', new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(high.createdOn)));
  await expect(activityTime).toHaveAttribute('title', new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(high.updatedOn)));
  await expect(createdTime).not.toBeEmpty();
  await expect(activityTime).not.toBeEmpty();

  const unread = page.getByTestId(`backlog-unread-badge-${high.id}`);
  await expect(unread).toContainText('123');
  await expect(unread).toHaveCSS('background-color', 'rgb(180, 35, 53)');
  await expect(page.getByTestId(`backlog-move-todo-${high.id}`)).toBeDisabled();
  await expect(page.getByTestId(`backlog-move-todo-${low.id}`)).toBeDisabled();

  const assertNoHorizontalOverflow = async () => {
    const metrics = await page.getByTestId('backlog-list').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await assertNoHorizontalOverflow();
  await page.setViewportSize({ width: 1600, height: 900 });
  await assertNoHorizontalOverflow();

  const search = page.getByRole('searchbox');
  await search.fill('Backlog lower priority');
  await expect(page.getByTestId(`backlog-row-${low.id}`)).toBeVisible();
  await expect(page.getByTestId(`backlog-row-${high.id}`)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Backlog lower priority');
  await search.press('Escape');
  await page.locator('.filter-toggle').click();
  await page.getByRole('button', { name: 'Save filter', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter name', exact: true }).fill('Round four backlog filter');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.keyboard.press('Escape');
  await search.fill('');
  await expect(page.getByTestId(`backlog-row-${high.id}`)).toBeVisible();
  await page.getByRole('button', { name: 'Round four backlog filter', exact: true }).click();
  await expect(page.getByTestId(`backlog-row-${low.id}`)).toBeVisible();
  await expect(page.getByTestId(`backlog-row-${high.id}`)).toHaveCount(0);
  await page.getByTestId('board').focus();
  await page.keyboard.press('q');
  await expect.poll(() => new URL(page.url()).searchParams.get('mine')).toBe('1');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Backlog lower priority');
  await expect(page.getByTestId(`backlog-row-${low.id}`)).toHaveCount(0);
  await page.keyboard.press('q');
  await expect.poll(() => new URL(page.url()).searchParams.get('mine')).toBeNull();
  await expect(page.getByTestId(`backlog-row-${low.id}`)).toBeVisible();
  await page.getByRole('button', { name: 'Delete saved filter: Round four backlog filter', exact: true }).click();
  await search.fill('');
  await expect(page.getByTestId(`backlog-row-${high.id}`)).toBeVisible();

  await unread.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator(`#journal-${journalId}`)).toBeVisible();
  await expect.poll(() => readCalls.length).toBe(1);
  expect(readCalls).toEqual([[`journal:${journalId}`]]);
  expect(commandPosts).toBe(0);
});

test('backlog quick action moves to configured To Do and keeps release membership', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await createBacklogIssue(request, boot, 'Backlog quick move with roadmap', {
    fixedVersionId: 100,
  });
  const expectedVersion = issue.fixedVersionId!;
  await openBacklog(page, boot.projects[0]!.id);
  const row = page.getByTestId(`backlog-row-${issue.id}`);
  await expect(row).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await row.locator('.backlog-row-open').focus();
  await page.keyboard.press('Meta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${boot.redmineUrl.replace(/\/$/, '')}/issues/${issue.id}`);
  await page.keyboard.press('s');
  await expect(page.locator('.quick-move-modal')).toContainText(`#${issue.id}`);
  await page.keyboard.press('Escape');
  const todoId = boot.statuses.find(status => status.key === 'todo')!.id;
  await page.getByTestId('new-issue').click();
  await expect(page.getByTestId('issue-dialog').getByRole('combobox', { name: 'Status', exact: true })).toContainText(boot.statuses.find(status => status.key === 'backlog')!.name);
  await page.keyboard.press('Escape');
  const orderedRows = await page.locator('.backlog-row').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-issue-id'))));
  const movedIndex = orderedRows.indexOf(issue.id);
  const nextFocusedId = orderedRows[movedIndex + 1] ?? orderedRows[movedIndex - 1];
  await row.getByTestId(`backlog-move-todo-${issue.id}`).click();
  await expect(page.getByTestId(`backlog-row-${nextFocusedId}`).locator('.backlog-row-open')).toBeFocused();
  await expect.poll(async () => (await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).issue.statusId).toBe(todoId);
  const moved = (await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).issue;
  expect(moved.fixedVersionId).toBe(expectedVersion);
  await expect(row).toHaveCount(0);
});
