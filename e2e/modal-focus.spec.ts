import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { Bootstrap, BoardData, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function assertVisibleHeaderFocusTrap(page: Page, dialog: Locator) {
  const menuSummary = dialog.locator('.issue-header-menu summary');
  await expect(menuSummary).toBeVisible();
  await expect(dialog.locator('.issue-header-menu button')).toBeHidden();

  const focusLastStop = () => dialog.evaluate(element => {
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])';
    const stops = [...element.querySelectorAll<HTMLElement>(selector)]
      .filter(item => item.getClientRects().length > 0 && !item.closest('[aria-hidden="true"]'));
    const last = stops.at(-1);
    if (!last) throw new Error('Issue dialog has no visible tab stops');
    last.focus();
  });
  const isLastStopFocused = () => dialog.evaluate(element => {
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])';
    const stops = [...element.querySelectorAll<HTMLElement>(selector)]
      .filter(item => item.getClientRects().length > 0 && !item.closest('[aria-hidden="true"]'));
    return document.activeElement === stops.at(-1);
  });

  await focusLastStop();
  await page.keyboard.press('Tab');
  await expect(menuSummary).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(isLastStopFocused).toBe(true);
}

async function openThroughDeferredIssueLoad(page: Page, request: APIRequestContext, issueId: number) {
  const issueGate = deferred();
  const dialogChunkGate = deferred();
  let resolveDialogChunkRequested!: () => void;
  const dialogChunkRequested = new Promise<void>(resolve => { resolveDialogChunkRequested = resolve; });

  await page.route(url => url.pathname === `/api/issues/${issueId}`, async (route: Route) => {
    await issueGate.promise;
    await route.continue();
  });
  await page.route(url => /\/assets\/IssueDialog-[^/]+\.js$/.test(url.pathname), async (route: Route) => {
    resolveDialogChunkRequested();
    await dialogChunkGate.promise;
    await route.continue();
  });

  const board = await (await request.get(`/api/projects/${(await bootstrap(request)).projects[0]!.id}/board`)).json() as BoardData;
  const issue = board.issues.find(item => item.id === issueId)!;
  await page.goto(`/?project=${issue.projectId}`);
  const card = page.getByTestId(`issue-card-${issue.id}`);
  const opener = card.getByRole('button', { name: 'Відкрити', exact: true });
  await opener.click();

  const loadingDialog = page.getByRole('dialog', { name: `#${issue.id}`, exact: true });
  await expect(loadingDialog).toBeVisible();
  await expect(loadingDialog.getByRole('button', { name: 'Закрити', exact: true })).toBeFocused();

  issueGate.resolve();
  await dialogChunkRequested;
  dialogChunkGate.resolve();

  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true }).first()).toBeFocused();
  return { dialog, opener, issue };
}

async function openThroughCachedIssueHandoff(page: Page, request: APIRequestContext, issueId: number, tabBeforeClose: boolean) {
  const boot = await bootstrap(request);
  const board = await (await request.get(`/api/projects/${boot.projects[0]!.id}/board`)).json() as BoardData;
  const issue = board.issues.find(item => item.id === issueId)!;
  await page.goto(`/?project=${issue.projectId}`);
  const card = page.getByTestId(`issue-card-${issue.id}`);
  const opener = card.getByRole('button', { name: 'Відкрити', exact: true });

  // Warm both React Query's issue cache and the lazy IssueDialog chunk first.
  await opener.click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await expect(opener).toBeFocused();

  // On a later open, the stale cached detail exists while the explicit refresh is held.
  const issueGate = deferred();
  await page.route(url => url.pathname === `/api/issues/${issueId}`, async (route: Route) => {
    await issueGate.promise;
    await route.continue();
  });
  await opener.click();
  const loadingDialog = page.getByRole('dialog', { name: `#${issue.id}`, exact: true });
  await expect(loadingDialog).toBeVisible();
  await expect(loadingDialog.getByRole('button', { name: 'Закрити', exact: true })).toBeFocused();
  issueGate.resolve();

  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true }).first()).toBeFocused();
  if (tabBeforeClose) {
    await assertVisibleHeaderFocusTrap(page, dialog);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('issue')).toBeNull();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(opener).toBeFocused();
}

async function bootstrap(request: APIRequestContext) {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  return boot;
}

async function createIssueWithOwnComment(request: APIRequestContext) {
  const boot = await bootstrap(request);
  const created = await (await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject: 'Modal focus nested dialog test', statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } })).json() as CommandResult;
  const issue: Issue = created.issue!;
  expect(issue).toBeTruthy();
  const comment = await request.post('/api/commands', { data: {
    type: 'comment', issueId: issue.id, input: { notes: 'Cancelable nested dialog comment' },
  } });
  expect(comment.ok()).toBe(true);
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const journal = detail.journals.find(item => item.notes === 'Cancelable nested dialog comment')!;
  expect(journal).toBeTruthy();
  return { issue, journal };
}

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { locale: 'uk' } });
});

test('delayed issue GET and lazy dialog handoff restore the card opener on Escape from initial focus', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const board = await (await request.get(`/api/projects/${boot.projects[0]!.id}/board`)).json() as BoardData;
  const issue = board.issues[0]!;
  const { dialog, opener } = await openThroughDeferredIssueLoad(page, request, issue.id);

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('issue')).toBeNull();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(opener).toBeFocused();
});

test('delayed issue GET and lazy dialog handoff restore the same opener after tabbing inside', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const board = await (await request.get(`/api/projects/${boot.projects[0]!.id}/board`)).json() as BoardData;
  const issue = board.issues[0]!;
  const { dialog, opener } = await openThroughDeferredIssueLoad(page, request, issue.id);

  await assertVisibleHeaderFocusTrap(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('issue')).toBeNull();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(opener).toBeFocused();
});

test('cached detail and warmed lazy dialog still restore the opener after a delayed refresh', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const board = await (await request.get(`/api/projects/${boot.projects[0]!.id}/board`)).json() as BoardData;
  await openThroughCachedIssueHandoff(page, request, board.issues[0]!.id, false);
});

test('cached detail and warmed lazy dialog restore the opener after tabbing inside', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const board = await (await request.get(`/api/projects/${boot.projects[0]!.id}/board`)).json() as BoardData;
  await openThroughCachedIssueHandoff(page, request, board.issues[0]!.id, true);
});

test('nested journal-delete cancel returns to its parent opener before the issue modal returns to the card', async ({ page, request }) => {
  const { issue, journal } = await createIssueWithOwnComment(request);
  await page.goto(`/?project=${issue.projectId}`);
  const card = page.getByTestId(`issue-card-${issue.id}`);
  const opener = card.getByRole('button', { name: 'Відкрити', exact: true });
  await opener.click();
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();

  const deleteButton = page.getByTestId(`journal-delete-${journal.id}`);
  await deleteButton.click();
  const confirmation = page.getByTestId('journal-delete-confirmation');
  await expect(confirmation).toBeVisible();
  await page.getByTestId('journal-delete-cancel').click();
  await expect(confirmation).not.toBeVisible();
  await expect(deleteButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('issue')).toBeNull();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(opener).toBeFocused();
});
