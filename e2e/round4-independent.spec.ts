import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bootstrap, CommandResult, Issue, IssueDetail, Notification } from '../src/shared/types.js';

async function bootstrap(request: APIRequestContext): Promise<Bootstrap> {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light' } });
  const value = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(value.mode).toBe('demo');
  return value;
}

async function createIssue(request: APIRequestContext, boot: Bootstrap, subject: string, statusId: number): Promise<Issue> {
  const response = await request.post('/api/commands', { data: { type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, statusId, assignedToId: boot.me.id, trackerId: 1, priorityId: boot.priorities[2]?.id } } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

function unreadNotifications(issue: Issue, actor: Bootstrap['me'], journalBase: number, count: number): Notification[] {
  return Array.from({ length: count }, (_, index) => {
    const journalId = journalBase + index;
    return { id: `journal:${journalId}`, projectId: issue.projectId, issueId: issue.id, journalId, actor,
      kind: 'comment', text: `Unread event ${index + 1}`, createdOn: new Date(Date.now() - (count - index) * 1_000).toISOString() };
  });
}

async function openProjectBoard(page: Page, projectId: number) {
  await page.addInitScript(id => localStorage.setItem('redmine-workspace:project', String(id)), projectId);
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByTestId('board')).toBeVisible();
}

test('captures board and backlog badge placement across desktop themes and widths', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const projectId = boot.projects[0]!.id;
  const todoId = boot.statuses.find(status => status.key === 'todo')!.id;
  const todo = await createIssue(request, boot, 'Round four visual QA card with a due date', todoId);
  const dueDate = '2099-12-31';
  const dueUpdate = await request.post('/api/commands', { data: { type: 'updateIssue', issueId: todo.id, input: { dueDate } } });
  expect(dueUpdate.ok()).toBe(true);
  const board = await (await request.get(`/api/projects/${projectId}/board`)).json() as { issues: Issue[] };
  const backlog = board.issues.find(issue => issue.projectId === projectId && issue.statusId === boot.statuses.find(status => status.key === 'backlog')!.id)!;
  const notifications = [...unreadNotifications(todo, boot.me, 981_000, 123), ...unreadNotifications(backlog, boot.me, 982_000, 123)];
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: notifications }));

  const output = join(process.cwd(), 'test-results', 'round4-independent');
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openProjectBoard(page, projectId);
  await expect(page.getByTestId(`issue-unread-badge-${todo.id}`)).toContainText('123');
  await expect(page.getByTestId(`issue-card-${todo.id}`).locator('.due-chip')).toBeVisible();

  for (const theme of ['light', 'dark'] as const) {
    await request.patch('/api/settings', { data: { theme } });
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible();
    for (const width of [1280, 1600] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByTestId(`issue-unread-badge-${todo.id}`)).toBeVisible();
      await page.screenshot({ path: join(output, `${theme}-${width}-board.png`) });

      await page.locator('.board-view-button').filter({ hasText: /^Backlog$/ }).click();
      await expect(page.getByTestId('backlog-list')).toBeVisible();
      await expect(page.getByTestId(`backlog-unread-badge-${backlog.id}`)).toContainText('123');
      await page.screenshot({ path: join(output, `${theme}-${width}-backlog.png`) });
      await page.locator('.board-view-button').filter({ hasText: /^All$/ }).click();
      await expect(page.getByTestId('board')).toBeVisible();
    }
  }
});

test('mixed unread journal waits until its comment and status change are separately visible', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const projectId = boot.projects[0]!.id;
  const todoId = boot.statuses.find(status => status.key === 'todo')!.id;
  const issue = await createIssue(request, boot, 'Round four mixed unread test issue', todoId);
  await request.patch('/api/settings', { data: { projectActivity: { [String(projectId)]: {
    comment: true, status: true, assignee: true, labels: false, field: false,
  } } } });
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const journalId = 984_321;
  const notes = Array.from({ length: 24 }, (_, index) => `Comment section ${index + 1}: ${'unread content remains available for review '.repeat(12)}`).join('\n\n');
  detail.journals.push({ id: journalId, user: boot.me, createdOn: new Date().toISOString(), notes,
    changes: [{ field: 'status', oldValue: 'Backlog', newValue: 'To Do' }] });
  let notifications = unreadNotifications(issue, boot.me, journalId, 1).map(item => ({ ...item, journalId, eventKinds: ['comment', 'status'] as ('comment' | 'status')[] }));
  const readCalls: string[][] = [];

  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: detail }));
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: notifications }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    const ids = route.request().postDataJSON().ids as string[];
    readCalls.push(ids);
    notifications = notifications.filter(item => !ids.includes(item.id));
    await route.fulfill({ json: { ok: true } });
  });

  await openProjectBoard(page, projectId);
  await page.getByTestId(`issue-card-${issue.id}`).locator('.card-hit-area').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  const comment = page.locator(`[data-unread-event-content="${journalId}:comment"]`);
  const status = page.locator(`[data-unread-event-content="${journalId}:status"]`);
  await expect(comment).toBeVisible();
  await comment.evaluate(element => {
    const root = element.closest<HTMLElement>('.issue-dialog-scroll')!;
    const elementTop = element.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTop = Math.max(0, elementTop - 64);
  });
  await page.waitForTimeout(1_350);
  expect(readCalls).toEqual([]);

  await status.scrollIntoViewIfNeeded();
  await expect.poll(() => readCalls.length, { timeout: 5_000 }).toBe(1);
  expect(readCalls).toEqual([[`journal:${journalId}`]]);
});
