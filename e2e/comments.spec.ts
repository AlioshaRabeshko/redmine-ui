import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, CommandResult, IssueDetail } from '../src/shared/types.js';

async function setup(request: APIRequestContext, notes: string) {
  await request.patch('/api/settings', { data: { locale: 'uk', theme: 'light', palette: 'blue' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const created = await (await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0].id, input: { subject: `Comment actions ${notes}` },
  } })).json() as CommandResult;
  const issue = created.issue!;
  expect((await request.post('/api/commands', { data: { type: 'comment', issueId: issue.id, input: { notes } } })).ok()).toBe(true);
  const detail = await read(request, issue.id);
  return { boot, issue, journal: detail.journals.find(journal => journal.notes === notes)! };
}
async function read(request: APIRequestContext, id: number) {
  return await (await request.get(`/api/issues/${id}`)).json() as IssueDetail;
}
async function open(page: Page, project: number, issue: number) {
  await page.goto(`/?project=${project}&issue=${issue}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

test('comment edit draft survives closing/reload; Cmd+S saves only that comment; delete requires confirmation', async ({ page, request }) => {
  const { issue, journal } = await setup(request, 'Original own comment');
  await open(page, issue.projectId, issue.id);
  const editor = page.getByTestId(`journal-editor-textarea-${journal.id}`);
  await page.getByTestId(`journal-edit-${journal.id}`).click();
  await editor.fill('Edited draft, still private');
  await page.screenshot({ path: '/tmp/redmine-ui-comment-editor.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();
  await page.reload();
  await open(page, issue.projectId, issue.id);
  await page.getByTestId(`journal-edit-${journal.id}`).click();
  await expect(editor).toHaveValue('Edited draft, still private');
  expect((await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('Original own comment');
  await page.locator('.description-area').fill('Independent issue draft');
  await editor.focus();
  await page.keyboard.press('Meta+s');
  await expect.poll(async () => (await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('Edited draft, still private');
  expect((await read(request, issue.id)).issue.description).not.toBe('Independent issue draft');
  await expect(editor).not.toBeVisible();
  await page.getByTestId(`journal-delete-${journal.id}`).click();
  await expect(page.getByTestId('journal-delete-confirmation')).toBeVisible();
  await page.getByTestId('journal-delete-cancel').click();
  expect((await read(request, issue.id)).journals.some(item => item.id === journal.id)).toBe(true);
  await page.getByTestId(`journal-delete-${journal.id}`).click();
  await page.getByTestId('journal-delete-confirm').click();
  await expect.poll(async () => (await read(request, issue.id)).journals.some(item => item.id === journal.id)).toBe(false);
});

test('quote appends to a retained draft, copy targets the exact Redmine comment, and like toggles once', async ({ page, request }) => {
  const { boot, issue, journal } = await setup(request, 'Quote this\nSecond line');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const commands: string[] = [];
  page.on('request', req => { if (req.url().endsWith('/api/commands') && req.method() === 'POST') commands.push(req.postDataJSON().type); });
  await open(page, issue.projectId, issue.id);
  const composer = page.getByTestId('comment-composer');
  await composer.fill('My existing draft');
  await page.getByTestId(`journal-quote-${journal.id}`).click();
  await expect(composer).toBeFocused();
  const quoted = await composer.inputValue();
  expect(quoted).toContain('My existing draft');
  expect(quoted).toContain(boot.me.name);
  expect(quoted).toContain('> Quote this');
  expect(quoted).toContain('> Second line');
  const permalink = `${boot.redmineUrl.replace(/\/$/, '')}/issues/${issue.id}#change-${journal.id}`;
  expect(quoted).toContain(permalink);
  await page.getByTestId(`journal-permalink-${journal.id}`).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(permalink);
  await page.screenshot({ path: '/tmp/redmine-ui-comment-actions.png' });
  expect(commands).toEqual([]);
  const like = page.getByTestId(`journal-like-${journal.id}`);
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await request.patch('/api/settings', { data: { theme: 'dark' } });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(composer).toHaveValue(quoted);
  await page.screenshot({ path: '/tmp/redmine-ui-comment-actions-dark.png' });
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  expect(commands).toHaveLength(2);
});

test('failed edit keeps its draft; text typed during a successful save remains unsaved', async ({ page, request }) => {
  const { issue, journal } = await setup(request, 'Pending edit original');
  await open(page, issue.projectId, issue.id);
  await page.getByTestId(`journal-edit-${journal.id}`).click();
  const editor = page.getByTestId(`journal-editor-textarea-${journal.id}`);
  await editor.fill('First attempted edit');
  await page.route('**/api/commands', route => route.fulfill({ status: 503, json: { code: 'CONNECTION_FAILED', message: 'Test unavailable' } }));
  await page.getByTestId(`journal-save-${journal.id}`).click();
  await expect(editor).toHaveValue('First attempted edit');
  await expect(page.getByTestId(`journal-editor-${journal.id}`).getByRole('alert')).toBeVisible();
  expect((await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('Pending edit original');
  await page.unroute('**/api/commands');
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/commands', async route => { await hold; await route.continue(); });
  await page.getByTestId(`journal-save-${journal.id}`).click();
  await editor.fill('Text written while saving');
  release();
  await expect.poll(async () => (await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('First attempted edit');
  await expect(editor).toHaveValue('Text written while saving');
  await page.unroute('**/api/commands');
  await page.getByTestId(`journal-save-${journal.id}`).click();
  await expect.poll(async () => (await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('Text written while saving');
});

test('real read-only still allows quote/permalink and cannot issue comment mutations', async ({ page, request }) => {
  const { issue, journal } = await setup(request, 'Read-only comment');
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const boot = await response.json() as Bootstrap;
    await route.fulfill({ json: { ...boot, mode: 'redmine', readOnly: true, capabilities: { ...boot.capabilities, canWrite: false } } });
  });
  let commands = 0;
  page.on('request', req => { if (req.url().endsWith('/api/commands') && req.method() === 'POST') commands++; });
  await open(page, issue.projectId, issue.id);
  await expect(page.getByTestId(`journal-edit-${journal.id}`)).toBeDisabled();
  await expect(page.getByTestId(`journal-delete-${journal.id}`)).toBeDisabled();
  await expect(page.getByTestId(`journal-like-${journal.id}`)).toBeDisabled();
  await expect(page.getByTestId(`journal-permalink-${journal.id}`)).toBeEnabled();
  await page.getByTestId(`journal-quote-${journal.id}`).click();
  expect(await page.getByTestId('comment-composer').inputValue()).toContain('Read-only comment');
  expect(commands).toBe(0);
});

test('a restored edit draft cannot overwrite a comment changed while the card was closed', async ({ page, request }) => {
  const { issue, journal } = await setup(request, 'Baseline before outside edit');
  await open(page, issue.projectId, issue.id);
  await page.getByTestId(`journal-edit-${journal.id}`).click();
  const editor = page.getByTestId(`journal-editor-textarea-${journal.id}`);
  await editor.fill('My unsaved edit');
  await page.keyboard.press('Escape');
  const outside = await request.post('/api/commands', { data: {
    type: 'editJournal', issueId: issue.id,
    input: { journalId: journal.id, expectedNotes: journal.notes, notes: 'Changed outside this editor' },
  } });
  expect(outside.ok()).toBe(true);
  await open(page, issue.projectId, issue.id);
  await page.getByTestId(`journal-edit-${journal.id}`).click();
  await expect(editor).toHaveValue('My unsaved edit');
  await expect(page.getByTestId(`journal-editor-${journal.id}`).getByRole('alert')).toBeVisible();
  await expect(page.getByTestId(`journal-save-${journal.id}`)).toBeDisabled();
  await expect(editor).toHaveValue('My unsaved edit');
  expect((await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('Changed outside this editor');
});

test('Cmd+S in the reply composer submits the reply once and leaves the description draft untouched', async ({ page, request }) => {
  const { issue } = await setup(request, 'Existing comment before keyboard reply');
  await open(page, issue.projectId, issue.id);
  await page.locator('.description-area').fill('Description remains a draft');
  const composer = page.getByTestId('comment-composer');
  await composer.fill('Reply submitted by keyboard');
  await page.keyboard.press('Meta+s');
  await expect.poll(async () => (await read(request, issue.id)).journals.filter(item => item.notes === 'Reply submitted by keyboard').length).toBe(1);
  await expect(composer).toHaveValue('');
  expect((await read(request, issue.id)).issue.description).not.toBe('Description remains a draft');
  await expect(page.locator('.description-area')).toHaveValue('Description remains a draft');
});

test('delete confirmation cannot remove a comment edited after confirmation opened', async ({ page, request }) => {
  const { issue, journal } = await setup(request, 'Text reviewed before deleting');
  await open(page, issue.projectId, issue.id);
  await page.getByTestId(`journal-delete-${journal.id}`).click();
  const changed = await request.post('/api/commands', { data: {
    type: 'editJournal', issueId: issue.id,
    input: { journalId: journal.id, expectedNotes: journal.notes, notes: 'New text while confirmation was open' },
  } });
  expect(changed.ok()).toBe(true);
  await expect(page.getByTestId(`journal-item-${journal.id}`).locator('.activity-rich-content p')).toHaveText('New text while confirmation was open');
  const failed = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().postDataJSON()?.type === 'deleteJournal');
  await page.getByTestId('journal-delete-confirm').click();
  expect((await failed).status()).toBe(409);
  await expect(page.getByTestId('journal-delete-confirmation').getByRole('alert')).toBeVisible();
  expect((await read(request, issue.id)).journals.find(item => item.id === journal.id)?.notes).toBe('New text while confirmation was open');
});
