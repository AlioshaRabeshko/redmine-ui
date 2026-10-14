import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue } from '../src/shared/types.js';
import { editDescriptionSource, sourceEditor } from './helpers/rich-editor.js';

async function bootstrap(request: APIRequestContext) {
  await request.patch('/api/settings', { data: { locale: 'uk' } });
  return await (await request.get('/api/bootstrap')).json() as Bootstrap;
}

async function createIssue(request: APIRequestContext, boot: Bootstrap, subject: string, description = ''): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, description, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

function createScope(boot: Bootstrap, projectId: number) {
  return `${boot.mode}:${boot.redmineUrl}:${boot.me.id}:${projectId}`;
}

function issueScope(boot: Bootstrap) {
  return `${boot.mode}:${boot.redmineUrl}:${boot.me.id}`;
}

function createDraftKey(scope: string, projectId: number, field: 'subject' | 'description') {
  return ['redmine-workspace', 'create-issue-draft', scope, String(projectId), field]
    .map(part => encodeURIComponent(part)).join(':');
}

function issueTextKey(scope: string, projectId: number, issueId: number, field: 'subject' | 'description') {
  return ['redmine-workspace', 'issue-draft', scope, String(projectId), String(issueId), field]
    .map(part => encodeURIComponent(part)).join(':');
}

async function start(page: Page, projectId: number) {
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByTestId('board')).toBeVisible();
}

test('legacy new-issue text survives blocked scoped writes and migrates after storage recovers', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const project = boot.projects[0]!;
  const scope = createScope(boot, project.id);
  const legacyKey = `redmine-workspace:new-draft:${encodeURIComponent(scope)}`;
  const subjectKey = createDraftKey(scope, project.id, 'subject');
  const descriptionKey = createDraftKey(scope, project.id, 'description');
  const legacyText = { subject: 'Legacy create title', description: 'Legacy create description' };
  const savedProperties = {
    statusId: boot.statuses.find(status => status.key === 'review')!.id,
    priorityId: boot.priorities[0]!.id,
    trackerId: 1,
  };

  await page.addInitScript(({ projectId, legacyKey, legacyText, savedProperties }) => {
    const seededKey = '__legacyNewDraftSeeded';
    if (!localStorage.getItem(seededKey)) {
      localStorage.setItem(seededKey, 'yes');
      localStorage.setItem('redmine-workspace:project', String(projectId));
      localStorage.setItem(legacyKey, JSON.stringify({ ...savedProperties, ...legacyText }));
    }
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && key.includes(':create-issue-draft:') && !localStorage.getItem('__allowNewDraftScopedWrites')) {
        throw new DOMException('Scoped draft quota exceeded', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
  }, { projectId: project.id, legacyKey, legacyText, savedProperties });

  await start(page, project.id);
  const openDialog = async () => {
    await page.getByTestId('new-issue').click();
    const dialog = page.getByTestId('issue-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  };

  let dialog = await openDialog();
  await expect(dialog.getByTestId('issue-title')).toHaveValue(legacyText.subject);
  await expect(await sourceEditor(page, 'issue-description-editor')).toHaveValue(legacyText.description);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-dialog')).not.toBeVisible();

  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  dialog = await openDialog();
  await expect(dialog.getByTestId('issue-title')).toHaveValue(legacyText.subject);
  await expect(await sourceEditor(page, 'issue-description-editor')).toHaveValue(legacyText.description);
  await expect.poll(() => page.evaluate(key => {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as Record<string, unknown> : null;
  }, legacyKey)).toMatchObject(savedProperties);

  const recovered = { subject: 'Recovered create title', description: 'Recovered create description' };
  await page.evaluate(() => localStorage.setItem('__allowNewDraftScopedWrites', 'yes'));
  await dialog.getByTestId('issue-title').fill(recovered.subject);
  await (await sourceEditor(page, 'issue-description-editor')).fill(recovered.description);
  await expect.poll(() => page.evaluate(keys => ({
    subject: localStorage.getItem(keys.subject),
    description: localStorage.getItem(keys.description),
  }), { subject: subjectKey, description: descriptionKey })).toEqual(recovered);
  await expect.poll(() => page.evaluate(key => {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as Record<string, unknown> : null;
  }, legacyKey)).toMatchObject(savedProperties);
  const legacyAfterMigration = await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>, legacyKey);
  expect(legacyAfterMigration).not.toHaveProperty('subject');
  expect(legacyAfterMigration).not.toHaveProperty('description');

  await page.keyboard.press('Escape');
  await page.reload();
  dialog = await openDialog();
  await expect(dialog.getByTestId('issue-title')).toHaveValue(recovered.subject);
  await expect(await sourceEditor(page, 'issue-description-editor')).toHaveValue(recovered.description);
});

test('issue legacy text stays available while scoped migration is blocked, then clears after recovery', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const project = boot.projects[0]!;
  const issue = await createIssue(request, boot, `Legacy issue migration ${Date.now()}`, 'Original server description');
  const scope = issueScope(boot);
  const legacyKey = `redmine-workspace:draft:${encodeURIComponent(scope)}:${project.id}:${issue.id}`;
  const descriptionKey = issueTextKey(scope, project.id, issue.id, 'description');
  const legacyDescription = 'Legacy issue description survives quota';

  await page.addInitScript(({ projectId, legacyKey, issueId, legacyDescription }) => {
    const seededKey = '__legacyIssueDraftSeeded';
    if (!localStorage.getItem(seededKey)) {
      localStorage.setItem(seededKey, 'yes');
      localStorage.setItem('redmine-workspace:project', String(projectId));
      localStorage.setItem(legacyKey, JSON.stringify({ description: legacyDescription }));
    }
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && key.includes(':issue-draft:') && !localStorage.getItem('__allowIssueDraftScopedWrites')) {
        throw new DOMException('Scoped draft quota exceeded', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
  }, { projectId: project.id, legacyKey, issueId: issue.id, legacyDescription });

  const url = `/?project=${project.id}&issue=${issue.id}`;
  await page.goto(url);
  let dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(await editDescriptionSource(page)).toHaveValue(legacyDescription);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.goto(url);
  dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(await editDescriptionSource(page)).toHaveValue(legacyDescription);

  const recoveredDescription = 'Recovered issue description';
  await page.evaluate(() => localStorage.setItem('__allowIssueDraftScopedWrites', 'yes'));
  await (await editDescriptionSource(page)).fill(recoveredDescription);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), descriptionKey)).toBe(recoveredDescription);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), legacyKey)).toBeNull();

  await page.keyboard.press('Escape');
  await page.reload();
  await page.goto(url);
  dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(await editDescriptionSource(page)).toHaveValue(recoveredDescription);
});

test('an issue draft tombstone suppresses older legacy text and keeps the server baseline', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const project = boot.projects[0]!;
  const baseline = `Tombstone baseline ${Date.now()}`;
  const issue = await createIssue(request, boot, `Legacy tombstone ${Date.now()}`, baseline);
  const scope = issueScope(boot);
  const legacyKey = `redmine-workspace:draft:${encodeURIComponent(scope)}:${project.id}:${issue.id}`;
  const descriptionKey = issueTextKey(scope, project.id, issue.id, 'description');

  await page.addInitScript(({ projectId, legacyKey, descriptionKey }) => {
    if (!localStorage.getItem('__legacyTombstoneSeeded')) {
      localStorage.setItem('__legacyTombstoneSeeded', 'yes');
      localStorage.setItem('redmine-workspace:project', String(projectId));
      localStorage.setItem(legacyKey, JSON.stringify({ description: 'Stale legacy description must not return' }));
      localStorage.setItem(descriptionKey, '\u0000redmine-workspace:draft-cleared:v1');
    }
  }, { projectId: project.id, legacyKey, descriptionKey });

  const url = `/?project=${project.id}&issue=${issue.id}`;
  await page.goto(url);
  let dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(await editDescriptionSource(page)).toHaveValue(baseline);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), legacyKey)).toBeNull();
  await page.reload();
  dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(await editDescriptionSource(page)).toHaveValue(baseline);
});
