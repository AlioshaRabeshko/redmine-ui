import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail, Notification } from '../src/shared/types.js';

async function fixture(request: APIRequestContext) {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject: 'Round five integration fixture', statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue as Issue;
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  return { boot, issue, detail };
}

test('quick move waits for fresh permissions and only offers confirmed transitions', async ({ page, request }) => {
  const { boot, issue, detail } = await fixture(request);
  const qa = boot.statuses.find(status => status.key === 'qa')!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async route => {
    await held;
    await route.fulfill({ json: { ...detail, statuses: boot.statuses, issue: { ...issue, allowedStatusIds: [qa.id] } } });
  });
  await page.goto(`/?project=${issue.projectId}&overlay=move&move=${issue.id}`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.quick-move-list')).toHaveCount(0);
  release();
  const dialog = page.locator('.quick-move-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.quick-move-list button')).toHaveCount(1);
  await expect(dialog.locator('.quick-move-list button')).toHaveText(qa.name);
});

test('unknown transitions offer no guessed status options', async ({ page, request }) => {
  const { issue, detail } = await fixture(request);
  const { allowedStatusIds: _ignored, ...withoutPermissions } = detail.issue;
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: { ...detail, issue: withoutPermissions } }));
  await page.goto(`/?project=${issue.projectId}&overlay=move&move=${issue.id}`);
  const dialog = page.locator('.quick-move-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.quick-move-list button')).toHaveCount(0);
  await expect(dialog).toContainText('No available status transitions have been confirmed');
});

test('creation notification has meaningful text and acknowledges only the clicked event after opening', async ({ page, request }) => {
  const { boot, issue } = await fixture(request);
  const actor = { id: boot.me.id + 1000, name: 'Other author' };
  const creation: Notification = { id: `issue:${issue.id}:created`, kind: 'issue_created', issueId: issue.id, projectId: issue.projectId,
    actor, text: 'Created', issueSubject: issue.subject, createdOn: issue.createdOn };
  const other: Notification = { ...creation, id: 'journal:999876', journalId: 999876, kind: 'comment', notes: 'Unrelated unread comment', text: 'Unrelated unread comment' };
  let notifications = [creation, other];
  const readCalls: string[][] = [];
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: notifications }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    const ids = route.request().postDataJSON().ids as string[];
    readCalls.push(ids);
    notifications = notifications.filter(item => !ids.includes(item.id));
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?project=${issue.projectId}&tab=inbox`);
  const row = page.getByTestId(`notification-${creation.id}`);
  await expect(row).toContainText('Created this issue');
  expect(readCalls).toEqual([]);
  await row.locator('.notification-open').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect.poll(() => readCalls.length).toBe(1);
  expect(readCalls).toEqual([[creation.id]]);
});
