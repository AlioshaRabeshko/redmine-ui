import { performance } from 'node:perf_hooks';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { AppSettings, BoardData, Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';
import { editDescriptionSource } from './helpers/rich-editor.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function createIssue(request: APIRequestContext, options: {
  projectId?: number; description?: string; assignedToGroupId?: number; dueDate?: string;
} = {}) {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light', palette: 'blue' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const projectId = options.projectId ?? boot.projects[0]!.id;
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId,
    input: {
      subject: `Round five corrections ${Date.now()}`,
      description: options.description ?? 'Baseline issue description.',
      statusId: boot.statuses.find(status => status.key === 'todo')!.id,
      ...(options.assignedToGroupId === undefined ? {} : { assignedToId: options.assignedToGroupId, assignedToType: 'group' }),
    },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue!;
  if (options.dueDate) {
    const updated = await request.post('/api/commands', { data: {
      type: 'updateIssue', issueId: issue.id, input: { dueDate: options.dueDate },
    } });
    expect(updated.ok()).toBe(true);
  }
  return { boot, projectId, issue };
}

async function readIssue(request: APIRequestContext, issueId: number): Promise<IssueDetail> {
  const response = await request.get(`/api/issues/${issueId}`);
  expect(response.ok()).toBe(true);
  return await response.json() as IssueDetail;
}

function draftKey(boot: Bootstrap, issue: Issue, field: 'subject' | 'description' | 'branch' | 'dueDate') {
  const scope = `${boot.mode}:${boot.redmineUrl}:${boot.me.id}`;
  return ['redmine-workspace', 'issue-draft', scope, String(issue.projectId), String(issue.id), field]
    .map(part => encodeURIComponent(part)).join(':');
}

async function openIssue(page: Page, issue: Issue) {
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

async function attachScreenshot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

test('scoped card and branch discard clear durable and tab-memory drafts without conflicts', async ({ page, request }) => {
  const dueDate = '2026-12-24';
  const { boot, issue } = await createIssue(request, { description: 'Server description stays intact.', dueDate });
  const keys = {
    subject: draftKey(boot, issue, 'subject'),
    description: draftKey(boot, issue, 'description'),
    branch: draftKey(boot, issue, 'branch'),
    dueDate: draftKey(boot, issue, 'dueDate'),
  };
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('redmine-workspace:issue-draft:') && key.endsWith(':branch')) {
        throw new DOMException('Simulated quota rejection for branch draft', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  const subjectDraft = `${issue.subject} — unsaved title`;
  const descriptionDraft = 'Unsaved description draft.';
  const branchDraft = 'feature/unsaved-branch';
  const dueDateDraft = '2027-01-15';
  await dialog.locator('input.input-title').fill(subjectDraft);
  await (await editDescriptionSource(page)).fill(descriptionDraft);
  await dialog.locator('.issue-main-fields .input-with-actions input').fill(branchDraft);
  await dialog.getByTestId('issue-due-date').fill(dueDateDraft);

  await expect(dialog.locator('.text-draft-conflict')).toHaveCount(0);
  await expect(dialog.getByTestId('discard-card-draft')).toBeVisible();
  await expect(dialog.getByTestId('discard-branch-draft')).toBeVisible();
  await expect(dialog.getByTestId('draft-persistence-status')).toContainText('only available in this tab');
  await expect.poll(async () => page.evaluate(draftKeys => Object.fromEntries(
    Object.entries(draftKeys).map(([field, key]) => [field, localStorage.getItem(key)]),
  ), keys)).toEqual({ subject: subjectDraft, description: descriptionDraft, branch: null, dueDate: dueDateDraft });

  await attachScreenshot(page, 'scoped-drafts-before-discard');
  await dialog.getByTestId('discard-card-draft').click();
  await expect(dialog.locator('input.input-title')).toHaveValue(issue.subject);
  await expect(dialog.getByTestId('issue-description-editor-source')).toHaveValue(issue.description);
  await expect(dialog.locator('.issue-main-fields .input-with-actions input')).toHaveValue(branchDraft);
  await expect(dialog.getByTestId('issue-due-date')).toHaveValue(dueDate);
  await expect(dialog.getByTestId('discard-card-draft')).toHaveCount(0);
  await expect(dialog.getByTestId('discard-branch-draft')).toBeVisible();
  await expect(dialog.locator('.text-draft-conflict')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(draftKeys => Object.fromEntries(
    Object.entries(draftKeys).map(([field, key]) => [field, localStorage.getItem(key)]),
  ), keys)).toEqual({ subject: null, description: null, branch: null, dueDate: null });
  expect((await readIssue(request, issue.id)).issue).toMatchObject({
    subject: issue.subject, description: issue.description, dueDate,
  });
  await expect(dialog.getByTestId('draft-persistence-status')).toContainText('only available in this tab');

  await dialog.getByTestId('discard-branch-draft').click();
  await expect(dialog.getByTestId('draft-persistence-status')).toHaveCount(0);
  await expect(dialog.locator('.issue-main-fields .input-with-actions input')).toHaveValue(issue.branch);
  await expect(dialog.locator('.text-draft-conflict')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId(`issue-card-${issue.id}`).locator('.card-hit-area').click();
  const reopened = page.getByTestId('issue-dialog');
  await expect(reopened.locator('input.input-title')).toHaveValue(issue.subject);
  await expect(reopened.getByTestId('issue-description-preview')).toContainText('Server description stays intact.');
  await expect(reopened.locator('.issue-main-fields .input-with-actions input')).toHaveValue(issue.branch);
  await expect(reopened.getByTestId('issue-due-date')).toHaveValue(dueDate);
});

test('a restored description draft opens in Preview and stays available when editing is requested', async ({ page, request }) => {
  const { boot, issue } = await createIssue(request, { description: 'Server description.' });
  const key = draftKey(boot, issue, 'description');
  const restoredDraft = 'Restored description draft with visible preview.';
  await page.addInitScript(({ storageKey, value }) => localStorage.setItem(storageKey, value), { storageKey: key, value: restoredDraft });
  await openIssue(page, issue);

  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog.getByTestId('issue-description-preview')).toContainText(restoredDraft);
  await expect(dialog.getByTestId('issue-description-edit-toggle')).toBeVisible();
  await expect(dialog.getByTestId('issue-description-editor')).toHaveCount(0);
  await expect(dialog.getByTestId('draft-persistence-status')).toContainText('Draft saved locally');
  await attachScreenshot(page, 'restored-description-preview');

  await dialog.getByTestId('issue-description-edit-toggle').click();
  const source = dialog.getByTestId('issue-description-editor').getByTestId('issue-description-editor-source-toggle');
  await expect(source).toBeVisible();
  await source.click();
  await expect(dialog.getByTestId('issue-description-editor-source')).toHaveValue(restoredDraft);
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(restoredDraft);
  expect((await readIssue(request, issue.id)).issue.description).toBe('Server description.');
});

test('journal actions are absent without confirmed capabilities and remain usable in demo', async ({ page, request }) => {
  const { boot, issue } = await createIssue(request);
  const notes = 'A demo comment with confirmed journal actions.';
  const comment = await request.post('/api/commands', { data: { type: 'comment', issueId: issue.id, input: { notes } } });
  expect(comment.ok()).toBe(true);
  const journal = (await readIssue(request, issue.id)).journals.find(item => item.notes === notes)!;
  expect(journal).toMatchObject({ canEdit: true, canDelete: true, canLike: true });

  await openIssue(page, issue);
  for (const action of ['edit', 'delete', 'like']) {
    const button = page.getByTestId(`journal-${action}-${journal.id}`);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  }
  const like = page.getByTestId(`journal-like-${journal.id}`);
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  expect((await readIssue(request, issue.id)).journals.find(item => item.id === journal.id)?.likedByMe).toBe(true);

  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    const journals = detail.journals.map(item => item.id === journal.id
      ? { ...item, canEdit: false, canDelete: false, canLike: false }
      : item);
    await route.fulfill({ response, json: { ...detail, journals } });
  });
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.getByTestId(`journal-item-${journal.id}`)).toBeVisible();
  await expect(page.getByTestId(`journal-edit-${journal.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`journal-delete-${journal.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`journal-like-${journal.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`journal-quote-${journal.id}`)).toBeEnabled();
  await expect(page.getByTestId(`journal-permalink-${journal.id}`)).toBeEnabled();
  await attachScreenshot(page, 'journal-actions-without-capabilities');
  expect(boot.mode).toBe('demo');
});

test('fresh issue details display while the board refresh is still pending', async ({ page, request }) => {
  const { issue } = await createIssue(request);
  const heldBoard = deferred();
  let boardRequests = 0;
  let completedBoardResponses = 0;
  let issueRequestCount = 0;
  let mentionRequestCount = 0;
  let issueResponseAt: number | undefined;
  page.on('request', req => {
    const pathname = new URL(req.url()).pathname;
    if (pathname === `/api/projects/${issue.projectId}/board`) boardRequests += 1;
    if (pathname === `/api/issues/${issue.id}`) issueRequestCount += 1;
    if (pathname === `/api/projects/${issue.projectId}/mention-users`) mentionRequestCount += 1;
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === `/api/issues/${issue.id}`) issueResponseAt = performance.now();
  });
  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, async route => {
    await heldBoard.promise;
    await route.continue();
    completedBoardResponses += 1;
  });

  const navigationStartedAt = performance.now();
  try {
    await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
    const dialog = page.getByTestId('issue-dialog');
    await expect(dialog).toBeVisible();
    const dialogVisibleAt = performance.now();
    await expect(dialog).toContainText(issue.subject);
    expect(boardRequests).toBeGreaterThan(0);
    expect(completedBoardResponses).toBe(0);
    expect(issueRequestCount).toBeGreaterThan(0);
    expect(issueResponseAt).toBeDefined();
    await expect.poll(() => mentionRequestCount).toBe(1);
    const measurement = {
      navigationToDialogVisibleMs: Number((dialogVisibleAt - navigationStartedAt).toFixed(1)),
      issueResponseToDialogVisibleMs: Number((dialogVisibleAt - issueResponseAt!).toFixed(1)),
      issueDetailRequests: issueRequestCount,
      projectMetadataRequests: mentionRequestCount,
      boardRequestsStartedBeforeDialog: boardRequests,
      boardResponsesCompletedWhenDialogVisible: completedBoardResponses,
      issueDialogVisibleBeforeBoardRefresh: completedBoardResponses === 0,
    };
    await test.info().attach('issue-open-structural-measurement.json', {
      body: Buffer.from(JSON.stringify(measurement, null, 2)), contentType: 'application/json',
    });
    await attachScreenshot(page, 'issue-open-before-board-refresh');
  } finally {
    heldBoard.resolve();
  }
  await expect.poll(() => completedBoardResponses).toBeGreaterThan(0);
});

test('empty comment composer loads the RichEditor module only after activation', async ({ page, request }) => {
  const { issue } = await createIssue(request, { description: 'Keep the description in Preview.' });
  const scriptResponses: { url: string; body: string }[] = [];
  const pendingScriptReads: Promise<void>[] = [];
  page.on('response', response => {
    if (!new URL(response.url()).pathname.endsWith('.js')) return;
    const pending = response.text().then(body => { scriptResponses.push({ url: response.url(), body }); }).catch(() => {});
    pendingScriptReads.push(pending);
  });
  const openedAt = performance.now();
  await openIssue(page, issue);
  await expect(page.getByTestId('comment-composer-activate')).toBeVisible();
  await expect(page.getByTestId('comment-composer')).toHaveCount(0);
  await expect(page.getByTestId('comment-composer-loading')).toHaveCount(0);
  await Promise.all(pendingScriptReads);
  const initialScriptUrls = scriptResponses.map(script => script.url);
  expect(scriptResponses.some(script => script.body.includes('data-redmine-source-image'))).toBe(false);

  await page.getByTestId('comment-composer-activate').click();
  const editorCanvas = page.getByTestId('comment-composer').getByTestId('comment-composer-visual');
  await expect(editorCanvas).toBeVisible();
  await expect.poll(async () => {
    await Promise.all(pendingScriptReads);
    return scriptResponses.some(script => script.body.includes('data-redmine-source-image'));
  }).toBe(true);
  const editorModule = scriptResponses.find(script => script.body.includes('data-redmine-source-image'))!;
  expect(initialScriptUrls).not.toContain(editorModule.url);
  const measurement = {
    issueDialogAndEmptyComposerMs: Number((performance.now() - openedAt).toFixed(1)),
    javascriptModulesBeforeComposerActivation: initialScriptUrls.length,
    richEditorChunkFetchedAfterActivation: true,
    richEditorChunkUrl: new URL(editorModule.url).pathname,
  };
  await test.info().attach('lazy-comment-editor-measurement.json', {
    body: Buffer.from(JSON.stringify(measurement, null, 2)), contentType: 'application/json',
  });
  await attachScreenshot(page, 'empty-comment-composer-before-activation');
  await expect(page.getByTestId('comment-composer-visual-toggle')).toBeVisible();
});

test('comment text entered into the loading fallback survives the delayed RichEditor chunk', async ({ page, request }) => {
  const { issue } = await createIssue(request);
  const chunkRequestStarted = deferred();
  const releaseChunk = deferred();
  let chunkUrl: string | undefined;
  await page.route(url => /\/assets\/RichEditor-[^/]+\.js$/.test(url.pathname), async route => {
    chunkUrl = route.request().url();
    chunkRequestStarted.resolve();
    await releaseChunk.promise;
    await route.continue();
  });

  await openIssue(page, issue);
  const activate = page.getByTestId('comment-composer-activate');
  await expect(activate).toBeVisible();
  await activate.click();
  await chunkRequestStarted.promise;

  const loadingFallback = page.getByTestId('comment-composer-loading');
  await expect(loadingFallback).toBeVisible();
  const comment = 'Typed safely while the RichEditor module is still loading.';
  await loadingFallback.fill(comment);
  await expect(loadingFallback).toHaveValue(comment);
  await attachScreenshot(page, 'comment-composer-while-rich-editor-chunk-is-held');

  releaseChunk.resolve();
  const visual = page.getByTestId('comment-composer').getByTestId('comment-composer-visual');
  await expect(visual).toBeVisible();
  await expect(visual.locator('[contenteditable="true"]')).toContainText(comment);
  const sourceToggle = page.getByTestId('comment-composer-source-toggle');
  await sourceToggle.click();
  await expect(page.getByTestId('comment-composer-source')).toHaveValue(comment);

  await test.info().attach('delayed-rich-editor-fallback-measurement.json', {
    body: Buffer.from(JSON.stringify({
      richEditorChunkRequestHeldUntilAfterInput: true,
      richEditorChunkPath: new URL(chunkUrl!).pathname,
      fallbackTestId: 'comment-composer-loading',
      charactersEnteredBeforeChunkRelease: comment.length,
      visualTextPreservedAfterChunkRelease: true,
      sourceTextPreservedAfterChunkRelease: true,
    }, null, 2)),
    contentType: 'application/json',
  });
});

test('group avatar settings update the mounted board cache without colliding with the same user ID', async ({ page, request }) => {
  const { boot } = await createIssue(request);
  const project = boot.projects[0]!;
  const board = await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData;
  const group = board.assigneeOptions?.find(option => option.type === 'group');
  expect(group).toBeDefined();
  if (!group || group.type !== 'group') throw new Error('The isolated demo project has no group fixture.');
  expect(board.assigneeOptions).toContainEqual(expect.objectContaining({ type: 'user', id: group.id }));

  const settingsBefore = await (await request.get('/api/settings')).json() as AppSettings;
  const previousGroup = settingsBefore.groupAvatarOverrides[String(group.id)] ?? null;
  const previousPerson = settingsBefore.personAvatarOverrides[String(group.id)] ?? null;
  await request.patch('/api/settings', { data: {
    groupAvatarOverrides: { [String(group.id)]: null },
    personAvatarOverrides: { [String(group.id)]: { kind: 'emoji', emoji: '🦊' } },
  } });
  const groupIssueResponse = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: project.id,
    input: {
      subject: `Group avatar cache ${Date.now()}`,
      statusId: boot.statuses.find(status => status.key === 'todo')!.id,
      assignedToId: group.id, assignedToType: 'group',
    },
  } });
  expect(groupIssueResponse.ok()).toBe(true);
  const groupIssue = (await groupIssueResponse.json() as CommandResult).issue!;
  const personIssue = board.issues.find(issue => issue.assignedToType !== 'group' && issue.assignedToId === group.id);
  expect(personIssue).toBeDefined();

  try {
    await page.goto(`/?project=${project.id}`);
    await expect(page.getByTestId(`issue-card-${groupIssue.id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-card-${personIssue!.id}`).locator('.avatar-local-emoji')).toHaveText('🦊');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const groupSettings = page.getByTestId('group-avatar-settings');
    await expect(groupSettings).toBeVisible();
    await expect(groupSettings.getByTestId('group-avatar-preview')).toContainText(group.name);
    await groupSettings.locator('.theme-options[role="group"] button').filter({ hasText: '🌈' }).click();
    await expect.poll(async () => {
      const settings = await (await request.get('/api/settings')).json() as AppSettings;
      return settings.groupAvatarOverrides[String(group.id)];
    }).toEqual({ kind: 'emoji', emoji: '🌈' });

    await page.getByRole('button', { name: 'All', exact: true }).click();
    const groupCard = page.getByTestId(`issue-card-${groupIssue.id}`);
    const personCard = page.getByTestId(`issue-card-${personIssue!.id}`);
    await expect(groupCard.locator('.group-avatar')).toContainText('🌈');
    await expect(personCard.locator('.person-stack .avatar-local-emoji')).toHaveText('🦊');
    await attachScreenshot(page, 'group-and-person-avatar-cache-collision');
    await page.reload();
    await expect(page.getByTestId(`issue-card-${groupIssue.id}`).locator('.group-avatar')).toContainText('🌈');
    await expect(page.getByTestId(`issue-card-${personIssue!.id}`).locator('.person-stack .avatar-local-emoji')).toHaveText('🦊');
  } finally {
    await request.patch('/api/settings', { data: {
      groupAvatarOverrides: { [String(group.id)]: previousGroup },
      personAvatarOverrides: { [String(group.id)]: previousPerson },
    } });
  }
});
