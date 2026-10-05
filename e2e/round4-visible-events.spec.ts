import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail, Journal, Notification } from '../src/shared/types.js';

async function createDemoIssue(request: APIRequestContext, boot: Bootstrap, subject: string): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

function journal(id: number, boot: Bootstrap, notes: string, changes: Journal['changes'] = [], minuteOffset = 0): Journal {
  return {
    id, user: boot.me, createdOn: new Date(Date.now() - minuteOffset * 60_000).toISOString(), notes, changes,
  };
}

function notification(issue: Issue, boot: Bootstrap, item: Journal, eventKinds: Notification['eventKinds'] = ['comment'], readAt?: string): Notification {
  return {
    id: `journal:${item.id}`, projectId: issue.projectId, issueId: issue.id, journalId: item.id,
    actor: boot.me, kind: eventKinds?.[0] || 'comment', eventKinds, text: item.notes,
    createdOn: item.createdOn, ...(readAt ? { readAt } : {}),
  };
}

async function installFixture(page: Page, issue: Issue, journals: Journal[], notifications: Notification[], options: { refreshJournals?: () => Journal[]; failFirstRead?: boolean } = {}) {
  let failuresRemaining = options.failFirstRead ? 1 : 0;
  const readRequests: string[][] = [];
  await page.route('**/api/events', route => route.abort());
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    const currentJournals = options.refreshJournals?.() ?? journals;
    await route.fulfill({ response, json: { ...detail, journals: currentJournals } });
  });
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: notifications }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    const ids = (route.request().postDataJSON() as { ids: string[] }).ids;
    readRequests.push(ids);
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      await route.fulfill({ status: 503, json: { code: 'DEMO_FAILURE', message: 'Fixture read failure' } });
      return;
    }
    await route.fulfill({ json: { updated: ids.length, unreadCount: 0 } });
  });
  return readRequests;
}

async function revealJournal(page: Page, journalId: number) {
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId(`journal-item-${journalId}`).evaluate(element => {
    const scroll = element.closest('.issue-dialog-scroll') as HTMLElement | null;
    if (!scroll) throw new Error('Issue dialog scroller is missing');
    const targetTop = element.querySelector<HTMLElement>('[data-unread-event-heading]')?.getBoundingClientRect().top
      ?? element.getBoundingClientRect().top;
    const scrollTop = scroll.getBoundingClientRect().top + scroll.clientTop;
    scroll.scrollTop += targetTop - scrollTop - 72;
  });
}

async function openIssue(page: Page, issue: Issue) {
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
});

test('normal open does not read offscreen history or already-read events; visible heading and comment dwell before exact acknowledgement', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Visible read dwell ${Date.now()}`);
  await request.patch('/api/settings', { data: { projectActivity: { [String(issue.projectId)]: { comment: true, status: true, assignee: true, labels: false, field: false } } } });
  const history = Array.from({ length: 14 }, (_, index) => journal(8_100_000 + issue.id * 20 + index, boot, `Older event ${index + 1}. ${'Long note segment. '.repeat(12)}`, [], index));
  const newest = history[0]!;
  const target = history[history.length - 1]!;
  const unread = notification(issue, boot, target);
  const alreadyRead = notification(issue, boot, newest, ['comment'], '2026-10-05T10:00:00.000Z');
  const reads = await installFixture(page, issue, history, [unread, alreadyRead]);

  await openIssue(page, issue);
  const scroll = page.getByTestId('issue-dialog').locator('.issue-dialog-scroll');
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(2);
  await page.waitForTimeout(1_250);
  expect(reads).toEqual([]);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(2);

  await revealJournal(page, target.id);
  await page.waitForTimeout(650);
  expect(reads).toEqual([]);
  await expect.poll(() => reads).toEqual([[unread.id]]);
  expect(reads.flat()).not.toContain(alreadyRead.id);
});

test('a mixed notification stays unread until every projected kind is shown by Activity preferences', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Mixed event visibility ${Date.now()}`);
  await request.patch('/api/settings', { data: { projectActivity: { [String(issue.projectId)]: { comment: true, status: true, assignee: true, labels: false, field: false } } } });
  const item = journal(8_200_000 + issue.id, boot, 'Visible comment text', [{ field: 'Labels', oldValue: 'old', newValue: 'new' }]);
  const mixed = notification(issue, boot, item, ['comment', 'labels']);
  const reads = await installFixture(page, issue, [item], [mixed]);

  await openIssue(page, issue);
  await revealJournal(page, item.id);
  await page.waitForTimeout(1_200);
  expect(reads).toEqual([]);

  await page.getByTestId('issue-dialog').getByTestId('activity-filter-labels').click();
  await expect(page.getByTestId(`journal-item-${item.id}`).locator('[data-activity-kind="labels"]')).toBeVisible();
  await page.waitForTimeout(650);
  expect(reads).toEqual([]);
  await expect.poll(() => reads).toEqual([[mixed.id]]);
});

test('a hidden document cancels dwell; returning to the active issue starts a fresh visible interval', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Hidden tab dwell ${Date.now()}`);
  const item = journal(8_300_000 + issue.id, boot, 'A visible event in the active tab');
  const unread = notification(issue, boot, item);
  const reads = await installFixture(page, issue, [item], [unread]);
  await page.addInitScript(() => {
    let visible = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => visible });
    Object.defineProperty(window, '__setSimulatedVisibility', {
      configurable: true,
      value: (next: boolean) => {
        visible = next;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event(next ? 'focus' : 'blur'));
      },
    });
  });

  await openIssue(page, issue);
  await revealJournal(page, item.id);
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as unknown as { __setSimulatedVisibility: (visible: boolean) => void }).__setSimulatedVisibility(false));
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
  await page.waitForTimeout(1_250);
  expect(reads).toEqual([]);

  await page.evaluate(() => (window as unknown as { __setSimulatedVisibility: (visible: boolean) => void }).__setSimulatedVisibility(true));
  await expect.poll(() => reads).toEqual([[unread.id]]);
});

test('buffered events stay unread until revealed; a failed acknowledgement is not retried endlessly but can retry after reopening', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Buffered visible read ${Date.now()}`);
  const target = journal(8_400_000 + issue.id, boot, 'New buffered activity comment');
  let includeBuffered = false;
  await request.patch('/api/settings', { data: { projectActivity: { [String(issue.projectId)]: { comment: true, status: true, assignee: true, labels: false, field: false } } } });
  const unread = notification(issue, boot, target);
  const reads = await installFixture(page, issue, [], [unread], {
    failFirstRead: true,
    refreshJournals: () => includeBuffered ? [target] : [],
  });

  await openIssue(page, issue);
  includeBuffered = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog.getByTestId('activity-new-events')).toBeVisible();
  await expect(dialog.getByTestId(`journal-item-${target.id}`)).toHaveCount(0);
  await page.waitForTimeout(1_200);
  expect(reads).toEqual([]);

  await dialog.getByTestId('show-new-activity').click();
  await expect(dialog.getByTestId(`journal-item-${target.id}`)).toBeVisible();
  await revealJournal(page, target.id);
  await expect.poll(() => reads).toEqual([[unread.id]]);
  await page.waitForTimeout(1_200);
  expect(reads).toEqual([[unread.id]]);

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await openIssue(page, issue);
  await revealJournal(page, target.id);
  await expect.poll(() => reads).toEqual([[unread.id], [unread.id]]);
});
