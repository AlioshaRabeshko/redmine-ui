import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail, Journal, Notification } from '../src/shared/types.js';

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p+0AAAAASUVORK5CYII=', 'base64');

async function createIssue(request: APIRequestContext, boot: Bootstrap, projectId: number, subject: string, extra: Record<string, unknown> = {}): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId,
    input: { subject, statusId: boot.statuses.find((status) => status.key === 'todo')!.id, ...extra },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

async function installJournals(page: Page, request: APIRequestContext, issues: Issue[], journalsForIssue: Record<number, Journal[]>) {
  const ids = new Set(issues.map((issue) => issue.id));
  const details = new Map<number, IssueDetail>();
  for (const issue of issues) {
    const response = await request.get(`/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const detail = await response.json() as IssueDetail;
    detail.journals = journalsForIssue[detail.issue.id] || [];
    details.set(issue.id, detail);
  }
  await page.route((url) => url.pathname.startsWith('/api/issues/') && ids.has(Number(url.pathname.split('/').at(-1))), async (route) => {
    const issueId = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: details.get(issueId)! });
  });
}

function journal(id: number, actor: { id: number; name: string }, createdOn: string, notes: string, changes: Journal['changes'] = []): Journal {
  return { id, user: actor, createdOn, notes, changes };
}

test('Inbox groups sort by latest issue event and reading or opening one event leaves its siblings unread', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk' } });
  const projectId = boot.projects[0]!.id;
  const first = await createIssue(request, boot, projectId, `Inbox group A ${Date.now()}`);
  const second = await createIssue(request, boot, projectId, `Inbox group B ${Date.now()}`);
  const actor = { id: 98_701, name: 'Inbox Actor' };
  let events: Notification[] = [
    { id: 'group-a-old', projectId, issueId: first.id, journalId: 98_701, actor, kind: 'comment', text: 'Older event for A', createdOn: '2026-10-04T10:00:00.000Z' },
    { id: 'group-b-latest', projectId, issueId: second.id, journalId: 98_703, actor, kind: 'comment', text: 'Latest event for B', createdOn: '2026-10-04T12:00:00.000Z' },
    { id: 'group-a-middle', projectId, issueId: first.id, journalId: 98_704, actor, kind: 'comment', text: 'Middle event for A', createdOn: '2026-10-04T10:30:00.000Z' },
    { id: 'group-a-latest', projectId, issueId: first.id, journalId: 98_702, actor, kind: 'comment', text: 'Latest event for A', createdOn: '2026-10-04T11:00:00.000Z' },
  ];
  const readCalls: string[][] = [];
  await page.route((url) => url.pathname === '/api/notifications', (route) => route.fulfill({ json: events }));
  await page.route((url) => url.pathname === '/api/notifications/read', async (route) => {
    const ids = route.request().postDataJSON().ids as string[];
    readCalls.push(ids);
    events = events.filter((event) => !ids.includes(event.id));
    await route.fulfill({ json: { ok: true } });
  });
  await installJournals(page, request, [first, second], {
    [first.id]: [
      journal(98_701, actor, '2026-10-04T10:00:00.000Z', 'Older event for A'),
      journal(98_704, actor, '2026-10-04T10:30:00.000Z', 'Middle event for A'),
      journal(98_702, actor, '2026-10-04T11:00:00.000Z', 'Latest event for A'),
    ],
    [second.id]: [journal(98_703, actor, '2026-10-04T12:00:00.000Z', 'Latest event for B')],
  });

  await page.goto(`/?project=${projectId}&tab=inbox`);
  const groups = page.locator('.notification-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute('data-testid', `notification-group-${second.id}`);
  await expect(groups.nth(1)).toHaveAttribute('data-testid', `notification-group-${first.id}`);
  const firstGroup = page.getByTestId(`notification-group-${first.id}`);
  const firstEvents = firstGroup.locator('.notification-group-events');
  await expect(firstEvents).toBeVisible();
  await expect(firstEvents.locator('.notification-row')).toHaveCount(3);
  await expect(firstGroup.locator('.notification-group-toggle')).toHaveCount(0);
  await expect(firstEvents.locator('.notification-row').first()).toHaveAttribute('data-testid', 'notification-group-a-latest');
  await expect(firstGroup.locator('.notification-row')).toHaveCount(3);
  expect(readCalls).toHaveLength(0); // Displaying the expanded group must not acknowledge its events.

  await firstGroup.getByTestId('notification-group-a-old').locator('.notification-open').click();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator('#journal-98701')).toBeVisible();
  await expect.poll(() => readCalls.length).toBe(1);
  expect(readCalls[0]).toEqual(['group-a-old']);
  expect(new URL(page.url()).searchParams.get('journal')).toBe('98701');

  await page.goBack();
  await expect(page.getByTestId(`notification-group-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`notification-group-${first.id}`).locator('.notification-row')).toHaveCount(2);
  await page.getByTestId(`notification-group-${first.id}`).getByTestId('notification-group-a-latest').getByRole('button', { name: 'Прочитати', exact: true }).click();
  await expect.poll(() => readCalls.length).toBe(2);
  expect(readCalls[1]).toEqual(['group-a-latest']);
  await expect(page.getByTestId(`notification-group-${first.id}`).locator('.notification-row')).toHaveCount(1);
  await page.getByTestId(`notification-group-${first.id}`).locator('.notification-group-mark-read').click();
  await expect.poll(() => readCalls.length).toBe(3);
  expect(readCalls[2]).toEqual(['group-a-middle']);
  await expect(page.getByTestId(`notification-group-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`notification-group-${second.id}`)).toBeVisible();
});

test('Activity filters in a card autosave for its whole project and stay isolated from another project', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk', projectActivity: { [boot.projects[0]!.id]: null, [boot.projects[1]!.id]: null } } });
  const firstProject = boot.projects[0]!;
  const otherProject = boot.projects[1]!;
  const first = await createIssue(request, boot, firstProject.id, `Activity filter first ${Date.now()}`);
  const second = await createIssue(request, boot, firstProject.id, `Activity filter second ${Date.now()}`);
  const other = await createIssue(request, boot, otherProject.id, `Activity filter other ${Date.now()}`);
  const actor = { id: 98_801, name: 'Activity Actor' };
  const visible = 'Comment remains visible';
  const labelChange = 'Only when labels are enabled';
  await installJournals(page, request, [first, second, other], Object.fromEntries([first, second, other].map((issue) => [issue.id, [
    journal(98_800 + issue.id, actor, '2026-10-04T10:00:00.000Z', visible, [{ field: 'Labels', oldValue: 'Old label', newValue: labelChange }]),
  ]])));

  await request.patch('/api/settings', { data: { projectActivity: { [firstProject.id]: { comment: true, status: true, assignee: true, labels: true, field: false } } } });
  await page.goto(`/?project=${firstProject.id}&issue=${first.id}`);
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog.getByTestId('activity-filter-controls')).toBeVisible();
  await expect(dialog.getByTestId(`journal-item-${98_800 + first.id}`)).toContainText(labelChange);
  await dialog.getByTestId('activity-filter-status').click();
  await dialog.getByTestId('activity-filter-assignee').click();
  await dialog.getByTestId('activity-filter-labels').click();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectActivity[String(firstProject.id)]).toEqual({ comment: true, status: false, assignee: false, labels: false, field: false });
  const filteredJournal = dialog.getByTestId(`journal-item-${98_800 + first.id}`);
  await expect(filteredJournal).toContainText(visible);
  await expect(filteredJournal).not.toContainText(labelChange);

  await page.goto(`/?project=${firstProject.id}&issue=${second.id}`);
  const secondDialog = page.getByTestId('issue-dialog');
  await expect(secondDialog.getByTestId('activity-filter-comment')).toHaveAttribute('aria-pressed', 'true');
  await expect(secondDialog.getByTestId('activity-filter-status')).toHaveAttribute('aria-pressed', 'false');
  await expect(secondDialog.getByTestId('activity-filter-assignee')).toHaveAttribute('aria-pressed', 'false');
  await expect(secondDialog.getByTestId('activity-filter-labels')).toHaveAttribute('aria-pressed', 'false');
  await expect(secondDialog.getByTestId(`journal-item-${98_800 + second.id}`)).toContainText(visible);
  await expect(secondDialog.getByTestId(`journal-item-${98_800 + second.id}`)).not.toContainText(labelChange);

  await page.goto(`/?project=${otherProject.id}&issue=${other.id}`);
  const otherDialog = page.getByTestId('issue-dialog');
  await expect(otherDialog.getByTestId('activity-filter-comment')).toHaveAttribute('aria-pressed', 'true');
  await expect(otherDialog.getByTestId('activity-filter-status')).toHaveAttribute('aria-pressed', 'true');
  await expect(otherDialog.getByTestId('activity-filter-assignee')).toHaveAttribute('aria-pressed', 'true');
  await expect(otherDialog.getByTestId('activity-filter-labels')).toHaveAttribute('aria-pressed', 'false');
  await request.patch('/api/settings', { data: { projectActivity: { [firstProject.id]: null, [otherProject.id]: null } } });
});

test('Activity puts newer journals first and keeps equal-time journal order deterministic', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = boot.projects[0]!.id;
  await request.patch('/api/settings', { data: { locale: 'uk', projectActivity: { [projectId]: { comment: true, status: true, assignee: true, labels: true, field: true } } } });
  const issue = await createIssue(request, boot, projectId, `Activity order ${Date.now()}`);
  const actor = { id: 98_901, name: 'Journal Actor' };
  const journals = [
    journal(98_911, actor, '2026-10-04T09:00:00.000Z', 'Oldest'),
    journal(98_912, actor, '2026-10-04T11:00:00.000Z', 'Newer, lower id'),
    journal(98_913, actor, '2026-10-04T11:00:00.000Z', 'Newer, higher id'),
  ];
  await installJournals(page, request, [issue], { [issue.id]: journals });
  await page.goto(`/?project=${projectId}&issue=${issue.id}`);
  const items = page.locator('.activity-list [data-testid^="journal-item-"]');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-testid', 'journal-item-98913');
  await expect(items.nth(1)).toHaveAttribute('data-testid', 'journal-item-98912');
  await expect(items.nth(2)).toHaveAttribute('data-testid', 'journal-item-98911');
  await expect(items.first()).toContainText('Newer, higher id');
  await request.patch('/api/settings', { data: { projectActivity: { [projectId]: null } } });
});

test('read-only indicator stays visible with a collapsed sidebar and in the card while blocked drafts remain local', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = (await (await request.get(`/api/projects/${boot.projects[0]!.id}/board`)).json()).issues[0] as Issue;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const current = await response.json() as Bootstrap;
    await route.fulfill({ response, json: { ...current, mode: 'redmine', readOnly: true, capabilities: { ...current.capabilities, canWrite: false } } });
  });
  let commandPosts = 0;
  page.on('request', (event) => { if (event.url().endsWith('/api/commands') && event.method() === 'POST') commandPosts++; });
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('.readonly-mode-pill')).toContainText('Лише читання');
  await expect(page.locator('.mode-banner')).toHaveCount(0);
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.locator('.app-frame')).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.readonly-mode-pill')).toBeVisible();
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog.locator('.readonly-dialog-status')).toContainText('Лише читання');
  const description = dialog.locator('.description-area');
  if (!(await description.isVisible())) await dialog.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await dialog.locator('.description-area').fill('Blocked draft survives reload');
  await expect(dialog.getByTestId('draft-persistence-status')).toContainText('Чернетку збережено локально');
  await page.keyboard.press('Meta+s');
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.locator('.description-area')).toHaveValue('Blocked draft survives reload');
  expect(commandPosts).toBe(0);
});

test('blocked browser storage warns about reload loss and keeps description and comment drafts on SPA reopen', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await request.patch('/api/settings', { data: { locale: 'uk' } });
  const projectId = boot.projects[0]!.id;
  const baseline = `Storage baseline ${Date.now()}`;
  const issue = await createIssue(request, boot, projectId, `Storage failure ${Date.now()}`, { description: baseline });
  const draft = `Unsaved when storage is blocked ${Date.now()}`;
  const commentDraft = `Comment only in this tab ${Date.now()}`;

  await page.addInitScript(() => {
    const nativeSetItem = Storage.prototype.setItem;
    Object.defineProperty(window, '__issueDraftStorageFailures', { configurable: true, value: 0, writable: true });
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && key.includes(':issue-draft:')) {
        (window as unknown as { __issueDraftStorageFailures: number }).__issueDraftStorageFailures++;
        throw new DOMException('Storage quota is unavailable for issue drafts', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
  });

  const issueUrl = `/?project=${projectId}&issue=${issue.id}`;
  await page.goto(issueUrl);
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const editor = dialog.locator('.description-area');
  if (!(await editor.isVisible())) await dialog.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await editor.fill(draft);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __issueDraftStorageFailures: number }).__issueDraftStorageFailures)).toBeGreaterThan(0);
  const persistenceStatus = dialog.getByTestId('draft-persistence-status');
  await expect(persistenceStatus).toContainText('Ця чернетка доступна лише в цій вкладці');
  await expect(persistenceStatus).toContainText('текст може зникнути');
  await dialog.getByTestId('comment-composer').fill(commentDraft);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __issueDraftStorageFailures: number }).__issueDraftStorageFailures)).toBeGreaterThan(1);
  await expect(dialog.locator('.comment-composer').getByTestId('draft-persistence-status')).toContainText('Ця чернетка доступна лише в цій вкладці');

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const reopened = page.getByTestId('issue-dialog');
  await expect(reopened.locator('.description-area')).toHaveValue(draft);
  await expect(reopened.getByTestId('comment-composer')).toHaveValue(commentDraft);
  await expect(reopened.locator('.issue-dialog-scroll > [data-testid="draft-persistence-status"]')).toContainText('Ця чернетка доступна лише в цій вкладці');
  await page.reload();
  const reloaded = page.getByTestId('issue-dialog');
  await expect(reloaded.locator('.description-area')).toHaveValue(baseline);
  await expect(reloaded.getByTestId('comment-composer')).toHaveValue('');
});

test('local person photo and emoji overrides survive reload, apply to board people, and reset independently', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = boot.projects[0]!.id;
  const assignedIssue = await createIssue(request, boot, projectId, `Avatar board projection ${Date.now()}`, { assignedToId: 3 });
  const previousSettings = await (await request.get('/api/settings')).json();
  await request.patch('/api/settings', { data: { locale: 'uk', personAvatarOverrides: { '2': null, '3': null } } });
  await page.goto(`/?project=${projectId}&tab=settings`);
  const settings = page.getByTestId('settings-page');
  const people = settings.locator('.settings-role-overrides');
  const picker = people.getByRole('combobox', { name: 'Ролі для відображення', exact: true });
  const selectPerson = async (id: number) => {
    await picker.click();
    await page.locator('.picker-popover').last().locator(`[role="option"][data-value="${id}"]`).click();
  };

  try {
    await selectPerson(2);
    await people.getByTestId('person-avatar-upload').setInputFiles({ name: 'avatar.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(people.locator('.notice-error')).toContainText('PNG, JPEG або WebP');
    expect((await (await request.get('/api/settings')).json()).personAvatarOverrides['2']).toBeUndefined();
    await people.getByTestId('person-avatar-upload').setInputFiles({ name: 'person.png', mimeType: 'image/png', buffer: tinyPng });
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides['2']?.kind).toBe('photo');
    const firstPhotoUrl = (await (await request.get('/api/settings')).json()).personAvatarOverrides['2'].url as string;

    await selectPerson(3);
    await people.locator('.theme-options[role="group"] button').filter({ hasText: '🦊' }).click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides['3']).toEqual({ kind: 'emoji', emoji: '🦊' });
    await selectPerson(2);

    let failNextPhotoSettingsPatch = true;
    const settingsRoute = '**/api/settings';
    await page.route(settingsRoute, async (route) => {
      if (failNextPhotoSettingsPatch && route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON() as { personAvatarOverrides?: Record<string, { kind?: string }> };
        if (patch.personAvatarOverrides?.['2']?.kind === 'photo') {
          failNextPhotoSettingsPatch = false;
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_SETTINGS_FAILURE', message: 'Mocked settings save failure.' }) });
          return;
        }
      }
      await route.continue();
    });
    await people.getByTestId('person-avatar-upload').setInputFiles({ name: 'failed-replacement.png', mimeType: 'image/png', buffer: tinyPng });
    await expect(people.locator('.notice-error')).toContainText('Не вдалося зберегти налаштування аватара.');
    expect((await (await request.get('/api/settings')).json()).personAvatarOverrides['2'].url).toBe(firstPhotoUrl);
    expect((await request.get(firstPhotoUrl)).ok()).toBe(true);
    expect((await (await request.get('/api/settings')).json()).personAvatarOverrides['3']).toEqual({ kind: 'emoji', emoji: '🦊' });

    await people.getByTestId('person-avatar-upload').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: tinyPng });
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides['2']?.url).not.toBe(firstPhotoUrl);
    const replacementPhotoUrl = (await (await request.get('/api/settings')).json()).personAvatarOverrides['2'].url as string;
    await expect.poll(async () => (await request.get(firstPhotoUrl)).status()).toBe(404);
    expect((await request.get(replacementPhotoUrl)).ok()).toBe(true);
    await page.unroute(settingsRoute);

    await page.reload();
    const reloadedPeople = page.getByTestId('settings-page').locator('.settings-role-overrides');
    await expect(reloadedPeople.getByRole('combobox', { name: 'Ролі для відображення', exact: true })).not.toContainText('Вибрати…');
    await expect(reloadedPeople.getByTestId('person-avatar-preview')).toBeVisible();
    await selectPerson(2);
    await expect(reloadedPeople.getByTestId('person-avatar-preview').locator('.avatar img')).toHaveAttribute('src', /^\/api\/people\/2\/avatar\?v=/);
    const avatarUrl = (await (await request.get('/api/settings')).json()).personAvatarOverrides['2'].url as string;
    expect(avatarUrl).toBe(replacementPhotoUrl);
    await expect((await request.get(avatarUrl)).ok()).toBe(true);

    await reloadedPeople.locator('.theme-options[role="group"] button').filter({ hasText: '🦊' }).click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides['2']).toEqual({ kind: 'emoji', emoji: '🦊' });
    await expect(reloadedPeople.getByTestId('person-avatar-preview').locator('.avatar-local-emoji')).toHaveText('🦊');
    await expect.poll(async () => (await request.get(replacementPhotoUrl)).status()).toBe(404);
    expect((await (await request.get('/api/settings')).json()).personAvatarOverrides['3']).toEqual({ kind: 'emoji', emoji: '🦊' });
    await page.reload();
    const stablePeople = page.getByTestId('settings-page').locator('.settings-role-overrides');
    await selectPerson(2);
    await expect(stablePeople.getByTestId('person-avatar-preview').locator('.avatar-local-emoji')).toHaveText('🦊');

    await stablePeople.locator('.project-background-actions .button-danger').click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides['2']).toBeUndefined();
    await expect(stablePeople.getByTestId('person-avatar-preview').locator('.avatar-local-emoji')).toHaveCount(0);
    expect((await (await request.get('/api/settings')).json()).personAvatarOverrides['3']).toEqual({ kind: 'emoji', emoji: '🦊' });

    await page.goto(`/?project=${projectId}`);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId(`issue-card-${assignedIssue.id}`).locator('.person-stack .avatar-local-emoji')).toHaveText('🦊');
    const otherProject = boot.projects[1]!;
    const otherBoard = await (await request.get(`/api/projects/${otherProject.id}/board`)).json();
    const crossProjectIssue = otherBoard.issues.find((issue: Issue) => issue.assignedToId === 3) as Issue;
    expect(crossProjectIssue).toBeTruthy();
    await page.goto(`/?project=${otherProject.id}`);
    await expect(page.getByTestId(`issue-card-${crossProjectIssue.id}`).locator('.person-stack .avatar-local-emoji')).toHaveText('🦊');
    await page.reload();
    const saved = await (await request.get('/api/settings')).json();
    expect(saved.personAvatarOverrides['3']).toEqual({ kind: 'emoji', emoji: '🦊' });
  } finally {
    await request.patch('/api/settings', { data: { personAvatarOverrides: { '2': previousSettings.personAvatarOverrides['2'] ?? null, '3': previousSettings.personAvatarOverrides['3'] ?? null } } });
  }
});
