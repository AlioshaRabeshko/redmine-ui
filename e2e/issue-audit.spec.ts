import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';

const mixedJournalId = 98101;
const attachmentId = 98102;
const brokenAttachmentId = 98103;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p+0AAAAASUVORK5CYII=', 'base64');

async function createDemoIssue(request: APIRequestContext, boot: Bootstrap, subject: string, description: string) {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, description, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

async function setup(request: APIRequestContext) {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light', palette: 'blue' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const activity = { comment: true, status: true, assignee: true, labels: false, field: false };
  await request.patch('/api/settings', { data: { projectActivity: { [boot.projects[0]!.id]: activity } } });
  const issue = await createDemoIssue(request, boot, 'Issue content and activity audit', 'Initial description');
  return { boot, issue, activity };
}

async function installIssueResponse(page: Page, issue: Issue, notes = 'Visible journal note') {
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    detail.issue.fixedVersionId = 99;
    detail.issue.description = [
      '# Audit description',
      '',
      '| Area | Result |',
      '| --- | --- |',
      '| Markdown | Ready |',
      '',
      '!screenshot.png! !broken.png!',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      '<script>window.auditXss = true</script>',
    ].join('\n');
    detail.issue.attachments = [
      { id: attachmentId, filename: 'screenshot.png', url: `https://redmine.example.test/attachments/download/${attachmentId}/screenshot.png`, size: tinyPng.length, contentType: 'image/png' },
      { id: brokenAttachmentId, filename: 'broken.png', url: `https://redmine.example.test/attachments/download/${brokenAttachmentId}/broken.png`, size: 10, contentType: 'image/png' },
    ];
    const secondPerson = { id: 2, name: 'Demo Developer' };
    detail.people = [{ id: 1, name: 'Demo User' }, secondPerson];
    detail.journals = [{
      id: mixedJournalId,
      user: secondPerson,
      notes,
      createdOn: '2026-10-04T09:30:00.000Z',
      changes: [
        { field: 'status_id', oldValue: '4', newValue: '5' },
        { field: 'assigned_to_id', oldValue: '1', newValue: '2' },
        { field: 'Labels', oldValue: '606', newValue: '607' },
        { field: 'Priority', oldValue: '2', newValue: '3' },
      ],
    }];
    await route.fulfill({ response, json: detail });
  });
  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, async route => {
    const response = await route.fetch();
    const board = await response.json() as { labelOptions?: { id: string; name: string; fieldId?: number }[] };
    board.labelOptions = [{ id: '606', name: 'Build: Succeeded', fieldId: 41 }, { id: '607', name: 'Build: Failed', fieldId: 41 }];
    await route.fulfill({ response, json: board });
  });
}

async function openIssue(page: Page, issue: Issue, journalId?: number) {
  const journalParam = journalId ? `&journal=${journalId}` : '';
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}${journalParam}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

test('description preview renders Markdown and known images safely while preserving source text', async ({ page, request }) => {
  const { boot, issue } = await setup(request);
  await installIssueResponse(page, issue);
  let imageRouteCalled = false;
  await page.route(url => url.pathname === `/api/issues/${issue.id}/attachments/${attachmentId}/content` || url.pathname === `/api/issues/${issue.id}/attachments/${brokenAttachmentId}/content`, async route => {
    if (route.request().url().endsWith(`/${brokenAttachmentId}/content`)) {
      await route.fulfill({ status: 404, json: { code: 'ATTACHMENT_NOT_FOUND', message: 'Fixture image is unavailable.' } });
      return;
    }
    imageRouteCalled = true;
    await route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng });
  });
  await openIssue(page, issue);
  const dialog = page.getByTestId('issue-dialog');
  const raw = await dialog.locator('.description-area').inputValue();
  expect(raw).toContain('!screenshot.png!');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = dialog.locator('.description-preview');
  await expect(preview.locator('h1')).toHaveText('Audit description');
  await expect(preview.locator('table')).toBeVisible();
  await expect(preview.locator('.rich-code-block .language-js')).toContainText('const answer = 42;');
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as Window & { auditXss?: boolean }).auditXss))).toBe(false);
  await expect(preview.locator('img').first()).toHaveAttribute('src', `/api/issues/${issue.id}/attachments/${attachmentId}/content`);
  await expect.poll(() => imageRouteCalled).toBe(true);
  await expect(preview.locator('.rich-image-failed a')).toHaveAttribute('href', `/api/issues/${issue.id}/attachments/${brokenAttachmentId}/content`);
  const releasePicker = dialog.getByRole('combobox', { name: 'Release', exact: true });
  await expect(releasePicker).toContainText('2026.09 Core');
  await releasePicker.click();
  await expect(page.locator('.picker-popover').last().getByRole('option', { name: /2026\.09 Core/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(await dialog.locator('.description-area').count()).toBe(0);

  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  expect(await dialog.locator('.description-area').inputValue()).toBe(raw);
  expect(boot.capabilities.canWrite).toBe(true); // The application server for this test is isolated demo mode.
});

test('mixed journals obey project visibility independently and a permalink reveals only its target', async ({ page, request }) => {
  const { boot, issue } = await setup(request);
  await installIssueResponse(page, issue, 'A comment kept beside allowed status and assignee changes.');
  await openIssue(page, issue);
  const item = page.getByTestId(`journal-item-${mixedJournalId}`);
  await expect(item).toContainText('A comment kept beside allowed status and assignee changes.');
  await expect(item).toContainText('Review');
  await expect(item).toContainText('QA');
  await expect(item).toContainText('Demo User');
  await expect(item).toContainText('Demo Developer');
  await expect(item).not.toContainText('Build: Failed');
  await expect(item).not.toContainText('Build: Succeeded');
  await expect(item).not.toContainText('Priority');

  const projectId = issue.projectId;
  await request.patch('/api/settings', { data: { projectActivity: { [projectId]: { comment: false, status: true, assignee: true, labels: true, field: false } } } });
  await openIssue(page, issue);
  const filtered = page.getByTestId(`journal-item-${mixedJournalId}`);
  await expect(filtered).not.toContainText('A comment kept beside allowed status and assignee changes.');
  await expect(filtered).toContainText('Review');
  await expect(filtered).toContainText('Build: Succeeded');
  await expect(filtered).toContainText('Build: Failed');
  await expect(filtered).not.toContainText('Priority');

  await openIssue(page, issue, mixedJournalId);
  const target = page.getByTestId(`journal-item-${mixedJournalId}`);
  await expect(page.locator('.activity-target-override')).toBeVisible();
  await expect(target).toContainText('A comment kept beside allowed status and assignee changes.');
  await expect(target).toContainText('Priority');
  const saved = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(saved.settings.projectActivity[String(projectId)]).toEqual({ comment: false, status: true, assignee: true, labels: true, field: false });
  expect(boot.projects.some(project => project.id === projectId)).toBe(true);
});

test('real read-only opens the formatted description, while edits stay as local drafts', async ({ page, request }) => {
  const { issue } = await setup(request);
  await installIssueResponse(page, issue);
  let imageRouteCalled = false;
  await page.route(url => url.pathname === `/api/issues/${issue.id}/attachments/${attachmentId}/content` || url.pathname === `/api/issues/${issue.id}/attachments/${brokenAttachmentId}/content`, async route => {
    if (route.request().url().endsWith(`/${brokenAttachmentId}/content`)) {
      await route.fulfill({ status: 404, json: { code: 'ATTACHMENT_NOT_FOUND', message: 'Fixture image is unavailable.' } });
      return;
    }
    imageRouteCalled = true;
    await route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng });
  });
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const boot = await response.json() as Bootstrap;
    await route.fulfill({ response, json: { ...boot, mode: 'redmine', readOnly: true,
      capabilities: { ...boot.capabilities, canWrite: false, journalEditing: false, journalDeleting: false, journalLikes: false } } });
  });
  let commands = 0;
  page.on('request', requestEvent => { if (requestEvent.url().endsWith('/api/commands') && requestEvent.method() === 'POST') commands++; });
  await openIssue(page, issue);
  const dialog = page.getByTestId('issue-dialog');
  const preview = dialog.locator('.description-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('img').first()).toHaveAttribute('src', `/api/issues/${issue.id}/attachments/${attachmentId}/content`);
  await expect.poll(() => imageRouteCalled).toBe(true);
  await expect(dialog.locator('.description-area')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = dialog.locator('.description-area');
  const original = await editor.inputValue();
  expect(original).toContain('!screenshot.png!');
  await editor.fill('Read-only local draft\n\n!screenshot.png!');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(preview).toContainText('Read-only local draft');
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toHaveValue('Read-only local draft\n\n!screenshot.png!');
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator('.description-area')).toHaveValue('Read-only local draft\n\n!screenshot.png!');
  await expect(page.locator('.description-preview')).toHaveCount(0);
  expect(commands).toBe(0);
});
