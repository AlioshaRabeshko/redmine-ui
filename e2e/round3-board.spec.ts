import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { BoardData, Bootstrap, CommandResult, Issue, IssueDetail, Journal, Notification } from '../src/shared/types.js';

async function createIssue(request: APIRequestContext, bootstrap: Bootstrap, subject: string): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: bootstrap.projects[0]!.id,
    input: {
      subject,
      statusId: bootstrap.statuses.find(status => status.key === 'todo')!.id,
      assignedToId: bootstrap.me.id,
    },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

async function installUnavailableEventStream(page: Page) {
  await page.route('**/api/events', route => route.abort());
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/bootstrap');
  const bootstrap = await response.json() as Bootstrap;
  expect(bootstrap.mode).toBe('demo');
  await request.patch('/api/settings', { data: { locale: 'en' } });
});

test('unread badges, combined board filters, saved filters, exact reads and removed-card focus fallback work together', async ({ page, request }) => {
  const bootstrap = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const project = bootstrap.projects[0]!;
  const issue = await createIssue(request, bootstrap, `Round three unread ${Date.now()}`);
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const actor = { id: bootstrap.me.id, name: bootstrap.me.name };
  const oldestJournalId = 991_001;
  const newestJournalId = 991_002;
  const journal = (id: number, notes: string): Journal => ({ id, user: actor, createdOn: `2026-10-05T${id === oldestJournalId ? '09' : '10'}:00:00.000Z`, notes, changes: [] });
  detail.journals = [...detail.journals, journal(oldestJournalId, 'Oldest unread board event'), journal(newestJournalId, 'Newer unread board event')];
  let notifications: Notification[] = [
    { id: `journal:${newestJournalId}`, issueId: issue.id, projectId: project.id, journalId: newestJournalId, actor, kind: 'comment', text: 'Newer', createdOn: '2026-10-05T10:00:00.000Z' },
    { id: `journal:${oldestJournalId}`, issueId: issue.id, projectId: project.id, journalId: oldestJournalId, actor, kind: 'comment', text: 'Older', createdOn: '2026-10-05T09:00:00.000Z' },
  ];
  const readCalls: string[][] = [];
  await installUnavailableEventStream(page);
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: notifications }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    const ids = route.request().postDataJSON().ids as string[];
    readCalls.push(ids);
    notifications = notifications.filter(item => !ids.includes(item.id));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: detail }));

  const query = new URLSearchParams({ project: String(project.id), q: issue.subject });
  await page.goto(`/?${query}`);
  const card = page.getByTestId(`issue-card-${issue.id}`);
  const badge = page.getByTestId(`issue-unread-badge-${issue.id}`);
  await expect(card).toBeVisible();
  await expect(badge).toContainText('2');

  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('checkbox', { name: 'With unread notifications' }).check();
  await expect.poll(() => new URL(page.url()).searchParams.get('notifications')).toBe('1');
  expect(new URL(page.url()).searchParams.get('q')).toBe(issue.subject);
  await page.getByRole('button', { name: 'Save filter' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Unread round three');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => {
    const settings = await (await request.get('/api/settings')).json();
    return settings.savedViews.find((saved: { name: string }) => saved.name === 'Unread round three')?.filters?.hasNotifications;
  }).toBe(true);

  await page.keyboard.press('Escape');
  await page.getByTestId('board').evaluate(element => (element as HTMLElement).focus());
  await page.keyboard.press('q');
  await expect.poll(() => new URL(page.url()).searchParams.get('mine')).toBe('1');
  expect(new URL(page.url()).searchParams.get('notifications')).toBe('1');
  expect(new URL(page.url()).searchParams.get('q')).toBe(issue.subject);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('mine')).toBeNull();
  expect(new URL(page.url()).searchParams.get('notifications')).toBe('1');
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('mine')).toBe('1');
  await page.getByTestId('board').evaluate(element => (element as HTMLElement).focus());
  await page.keyboard.press('q');
  await expect.poll(() => new URL(page.url()).searchParams.get('mine')).toBeNull();
  expect(new URL(page.url()).searchParams.get('notifications')).toBe('1');
  await page.getByRole('button', { name: 'Unread round three', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('notifications')).toBe('1');

  await page.getByTestId(`issue-unread-badge-${issue.id}`).click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator(`#journal-${oldestJournalId}`)).toBeVisible();
  await expect.poll(() => readCalls.length).toBe(1);
  expect(readCalls).toEqual([[`journal:${oldestJournalId}`]]);
  await expect(page.getByTestId(`issue-unread-badge-${issue.id}`)).toContainText('1');
  await expect(page.locator(`#journal-${newestJournalId}`)).toBeVisible();

  notifications = [];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId(`issue-card-${issue.id}`)).toHaveCount(0);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('journal')).toBe(String(oldestJournalId));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeFocused();
});

test('notification stays unread when issue details load but the board needed for its dialog fails', async ({ page, request }) => {
  const bootstrap = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const project = bootstrap.projects[0]!;
  const issue = await createIssue(request, bootstrap, `Round three board failure ${Date.now()}`);
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const journalId = 992_001;
  detail.journals = [...detail.journals, { id: journalId, user: bootstrap.me, createdOn: '2026-10-05T09:00:00.000Z', notes: 'Target before board failure', changes: [] }];
  const notification: Notification = {
    id: `journal:${journalId}`, issueId: issue.id, projectId: project.id, journalId,
    actor: bootstrap.me, kind: 'comment', text: 'Board failure target', createdOn: '2026-10-05T09:00:00.000Z',
  };
  let failBoard = false;
  let boardFailures = 0;
  const readCalls: string[][] = [];
  await installUnavailableEventStream(page);
  await page.route(url => url.pathname === `/api/projects/${project.id}/board`, async route => {
    if (failBoard) {
      boardFailures += 1;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'BOARD_FAILED', message: 'Synthetic board failure' }) });
      return;
    }
    await route.fulfill({ json: await (await request.get(`/api/projects/${project.id}/board`)).json() });
  });
  await page.route(url => url.pathname === '/api/notifications', route => route.fulfill({ json: [notification] }));
  await page.route(url => url.pathname === '/api/notifications/read', async route => {
    readCalls.push(route.request().postDataJSON().ids as string[]);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: detail }));

  await page.goto(`/?project=${project.id}`);
  await expect(page.getByTestId(`issue-unread-badge-${issue.id}`)).toBeVisible();
  failBoard = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => boardFailures).toBeGreaterThan(0);
  await expect(page.getByTestId(`issue-unread-badge-${issue.id}`)).toBeVisible();

  await page.getByTestId(`issue-unread-badge-${issue.id}`).click();
  await expect(page.locator('.center-loading')).toBeVisible();
  await expect(page.getByTestId('issue-dialog')).toHaveCount(0);
  await expect.poll(() => readCalls.length).toBe(0);
  expect(new URL(page.url()).searchParams.get('issue')).toBe(String(issue.id));
});

test('board polling recovers from a dropped event stream without reloading', async ({ page, request }) => {
  const bootstrap = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const project = bootstrap.projects[0]!;
  const originalBoard = await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData;
  const issue = originalBoard.issues[0]!;
  const beforeBoard = structuredClone(originalBoard);
  const afterBoard = structuredClone(originalBoard);
  afterBoard.issues = afterBoard.issues.map(item => item.id === issue.id ? { ...item, subject: 'Updated through fallback polling' } : item);
  let updated = false;
  await installUnavailableEventStream(page);
  await page.route(url => url.pathname === `/api/projects/${project.id}/board`, route => route.fulfill({ json: updated ? afterBoard : beforeBoard }));

  await page.goto(`/?project=${project.id}`);
  const card = page.getByTestId(`issue-card-${issue.id}`);
  await expect(card.locator('h3')).toHaveText(issue.subject);
  const originalUrl = page.url();
  updated = true;
  await expect(card.locator('h3')).toHaveText('Updated through fallback polling', { timeout: 18_000 });
  expect(page.url()).toBe(originalUrl);
});

test('active issue polling buffers incoming activity without disturbing the comment draft or scroll', async ({ page, request }) => {
  const bootstrap = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createIssue(request, bootstrap, `Round three active issue fallback ${Date.now()}`);
  const initialDetail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const incomingJournalId = 994_001;
  let latestDetail = structuredClone(initialDetail);
  const incomingJournal: Journal = {
    id: incomingJournalId,
    user: { id: bootstrap.me.id, name: bootstrap.me.name },
    createdOn: new Date().toISOString(),
    notes: 'Arrived while the issue dialog was open',
    changes: [],
  };
  await installUnavailableEventStream(page);
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: latestDetail }));

  await page.goto(`/?project=${issue.projectId}`);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const comment = dialog.getByTestId('comment-composer');
  const draft = 'Keep this unsent comment while new Activity arrives';
  await comment.fill(draft);
  const issueScroll = dialog.locator('.issue-dialog-scroll');
  const scrollBefore = await issueScroll.evaluate(element => {
    const scroller = element as HTMLElement;
    scroller.scrollTop = Math.min(120, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    return scroller.scrollTop;
  });

  latestDetail = { ...latestDetail, journals: [...latestDetail.journals, incomingJournal] };
  await expect(page.getByTestId('activity-new-events')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`#journal-${incomingJournalId}`)).toHaveCount(0);
  await expect(comment).toHaveValue(draft);
  await expect.poll(() => issueScroll.evaluate(element => (element as HTMLElement).scrollTop)).toBe(scrollBefore);

  await page.getByTestId('show-new-activity').click();
  await expect(page.locator(`#journal-${incomingJournalId}`)).toBeVisible();
  await expect(comment).toHaveValue(draft);
});
