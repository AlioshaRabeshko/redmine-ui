import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { BoardData, Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';

async function bootstrap(request: APIRequestContext): Promise<Bootstrap> {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light' } });
  const result = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(result.mode).toBe('demo');
  return result;
}

async function createIssue(request: APIRequestContext, boot: Bootstrap, subject: string, statusId: number): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, statusId, assignedToId: boot.me.id, trackerId: 1 },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

function commandResult(issue: Issue, status: 'done' | 'failed' | 'blocked', errorCode?: string): CommandResult {
  return { operation: {
    id: `round4-${issue.id}`, type: 'moveIssue', issueId: issue.id, status, steps: [],
    createdOn: new Date().toISOString(), ...(errorCode ? { errorCode, retryable: false } : {}),
  }, issue };
}

async function launch(page: Page, issue: Issue) {
  await page.route('**/api/events', route => route.abort());
  await page.addInitScript(id => localStorage.setItem('redmine-workspace:project', String(id)), issue.projectId);
  await page.goto(`/?project=${issue.projectId}`);
  await expect(page.getByTestId(`issue-card-${issue.id}`)).toBeVisible();
}

async function dropIntoStatus(page: Page, issue: Issue, statusId: number) {
  const source = page.locator('.board-lanes').getByTestId(`issue-card-${issue.id}`).locator('.card-hit-area');
  const target = page.getByTestId(`lane-status:${statusId}`);
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Drag source or target is not visible');
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const sourcePoint = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const targetPoint = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + Math.min(targetBox.height / 2, 220) };
  const inViewport = (point: typeof sourcePoint) => point.x >= 0 && point.y >= 0
    && point.x <= viewport.width && point.y <= viewport.height;
  if (!inViewport(sourcePoint) || !inViewport(targetPoint)) throw new Error('Drag source and target must both be in the viewport');
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 8, sourcePoint.y, { steps: 2 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 15 });
  await page.mouse.up();
}

function boardIssueDetail(issue: Issue): IssueDetail {
  return { issue, journals: [], watchers: [] };
}

test.beforeEach(async ({ request }) => { await bootstrap(request); });

test('shows a move immediately, keeps it over stale board responses, and confirms the remote result', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const review = boot.statuses.find(status => status.key === 'review')!;
  const qa = boot.statuses.find(status => status.key === 'qa')!;
  const issue = await createIssue(request, boot, `Round four optimistic move ${Date.now()}`, review.id);
  const staleBoard = await (await request.get(`/api/projects/${issue.projectId}/board`)).json() as BoardData;
  let boardReads = 0;
  let actual = issue;
  let releaseCommand!: () => void;
  let markCommandArrived!: () => void;
  const commandGate = new Promise<void>(resolve => { releaseCommand = resolve; });
  const commandArrived = new Promise<void>(resolve => { markCommandArrived = resolve; });
  let moveCalls = 0;

  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, route => { boardReads++; return route.fulfill({ json: staleBoard }); });
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: boardIssueDetail(actual) }));
  await page.route(url => url.pathname === '/api/commands', async (route: Route) => {
    const command = route.request().postDataJSON() as { type: string };
    if (command.type !== 'moveIssue') return route.continue();
    moveCalls++;
    markCommandArrived();
    await commandGate;
    actual = { ...issue, statusId: qa.id, updatedOn: new Date(Date.parse(issue.updatedOn) + 60_000).toISOString() };
    await route.fulfill({ json: commandResult(actual, 'done') });
  });
  await launch(page, issue);

  await dropIntoStatus(page, issue, qa.id);
  await commandArrived;
  const card = page.locator('.board-lanes').getByTestId(`issue-card-${issue.id}`);
  await expect(page.getByTestId(`lane-status:${qa.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('.actual-status')).toHaveText('Saving…');
  await expect(card.locator('.card-hit-area')).toHaveAttribute('aria-disabled', 'true');

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => boardReads).toBeGreaterThan(1);
  await expect(page.getByTestId(`lane-status:${qa.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();
  await expect(card.locator('.actual-status')).toHaveText('Saving…');

  releaseCommand();
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId(`lane-status:${qa.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();

  // A delayed pre-command board snapshot after success must not snap the card back.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => boardReads).toBeGreaterThan(2);
  await expect(page.getByTestId(`lane-status:${qa.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();
  expect(moveCalls).toBe(1);
});

test('a definite refusal returns to the freshly confirmed original state without a compensating write', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const review = boot.statuses.find(status => status.key === 'review')!;
  const qa = boot.statuses.find(status => status.key === 'qa')!;
  const issue = await createIssue(request, boot, `Round four refused move ${Date.now()}`, review.id);
  const staleBoard = await (await request.get(`/api/projects/${issue.projectId}/board`)).json() as BoardData;
  let moveCalls = 0;
  let markCommandArrived!: () => void;
  const commandArrived = new Promise<void>(resolve => { markCommandArrived = resolve; });

  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, route => route.fulfill({ json: staleBoard }));
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: boardIssueDetail(issue) }));
  await page.route(url => url.pathname === '/api/commands', async (route: Route) => {
    const command = route.request().postDataJSON() as { type: string };
    if (command.type !== 'moveIssue') return route.continue();
    moveCalls++;
    markCommandArrived();
    await route.fulfill({ json: commandResult(issue, 'failed', 'TRANSITION_NOT_ALLOWED') });
  });
  await launch(page, issue);

  await dropIntoStatus(page, issue, qa.id);
  await commandArrived;
  await expect(page.getByTestId(`lane-status:${review.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();
  await expect(page.locator('.board-lanes').getByTestId(`issue-card-${issue.id}`)).not.toHaveAttribute('aria-busy', 'true');
  expect(moveCalls).toBe(1);
});

test('an uncertain partial move stays in Checking until a fresh issue read succeeds', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const review = boot.statuses.find(status => status.key === 'review')!;
  const qa = boot.statuses.find(status => status.key === 'qa')!;
  const issue = await createIssue(request, boot, `Round four partial move ${Date.now()}`, review.id);
  const staleBoard = await (await request.get(`/api/projects/${issue.projectId}/board`)).json() as BoardData;
  const actual = { ...issue, statusId: qa.id, updatedOn: new Date(Date.parse(issue.updatedOn) + 60_000).toISOString() };
  let issueReads = 0;
  let moveStarted = false;
  let moveCalls = 0;
  let markCommandArrived!: () => void;
  const commandArrived = new Promise<void>(resolve => { markCommandArrived = resolve; });

  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, route => route.fulfill({ json: staleBoard }));
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async route => {
    if (moveStarted) {
      issueReads++;
      if (issueReads <= 2) return route.fulfill({ status: 503, json: { code: 'REDMINE_UNAVAILABLE', message: 'Fixture transient read failure' } });
    }
    return route.fulfill({ json: await boardIssueDetail(actual) });
  });
  await page.route(url => url.pathname === '/api/commands', async (route: Route) => {
    const command = route.request().postDataJSON() as { type: string };
    if (command.type !== 'moveIssue') return route.continue();
    moveStarted = true;
    moveCalls++;
    markCommandArrived();
    await route.fulfill({ json: commandResult(actual, 'blocked', 'OUTCOME_UNKNOWN') });
  });
  await launch(page, issue);

  await dropIntoStatus(page, issue, qa.id);
  await commandArrived;
  const card = page.locator('.board-lanes').getByTestId(`issue-card-${issue.id}`);
  await expect(card.locator('.actual-status')).toHaveText('Checking…');
  await expect(page.getByTestId(`lane-status:${qa.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();
  await expect.poll(() => issueReads).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId(`lane-status:${qa.id}`).getByTestId(`issue-card-${issue.id}`)).toBeVisible();
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  expect(moveCalls).toBe(1);
});

test('verified 404 removes an inaccessible held issue instead of restoring stale board data', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const review = boot.statuses.find(status => status.key === 'review')!;
  const qa = boot.statuses.find(status => status.key === 'qa')!;
  const issue = await createIssue(request, boot, `Round four inaccessible move ${Date.now()}`, review.id);
  const staleBoard = await (await request.get(`/api/projects/${issue.projectId}/board`)).json() as BoardData;
  let moveCalls = 0;
  let moveStarted = false;
  let markCommandArrived!: () => void;
  const commandArrived = new Promise<void>(resolve => { markCommandArrived = resolve; });

  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, route => route.fulfill({ json: staleBoard }));
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => moveStarted
    ? route.fulfill({ status: 404, json: { code: 'ISSUE_NOT_FOUND', message: 'Fixture issue not found' } })
    : route.fulfill({ json: boardIssueDetail(issue) }));
  await page.route(url => url.pathname === '/api/commands', async (route: Route) => {
    const command = route.request().postDataJSON() as { type: string };
    if (command.type !== 'moveIssue') return route.continue();
    moveStarted = true;
    moveCalls++;
    markCommandArrived();
    await route.fulfill({ json: commandResult(issue, 'blocked', 'OUTCOME_UNKNOWN') });
  });
  await launch(page, issue);

  await dropIntoStatus(page, issue, qa.id);
  await commandArrived;
  await expect(page.locator('.board-lanes').getByTestId(`issue-card-${issue.id}`)).toHaveCount(0);
  expect(moveCalls).toBe(1);
});
