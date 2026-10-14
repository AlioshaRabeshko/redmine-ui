import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Bootstrap, BoardData, CommandResult, Issue } from '../src/shared/types.js';

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p+0AAAAASUVORK5CYII=', 'base64');

async function createGroupIssue(request: APIRequestContext, boot: Bootstrap, projectId: number, groupId: number): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId,
    input: { subject: `Group avatar ${Date.now()}`, statusId: boot.statuses.find(status => status.key === 'todo')!.id, assignedToId: groupId, assignedToType: 'group' },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue!;
  expect(issue).toMatchObject({ assignedToId: groupId, assignedToType: 'group' });
  return issue;
}

test('local group photo and emoji render for a colliding group ID without changing the person avatar', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const project = boot.projects[0]!;
  const board = await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData;
  const candidate = board.assigneeOptions?.find(option => option.type === 'group');
  expect(candidate?.id).toBe(2);
  if (!candidate || candidate.type !== 'group') throw new Error('Demo group fixture is missing.');
  const group = candidate;
  expect(boot.me.id).not.toBe(group.id);
  const issue = await createGroupIssue(request, boot, project.id, group.id);
  const previous = await (await request.get('/api/settings')).json();
  const previousGroup = previous.groupAvatarOverrides?.[String(group.id)] ?? null;
  const previousPerson = previous.personAvatarOverrides?.[String(group.id)] ?? null;
  try {
    await request.patch('/api/settings', { data: {
      locale: 'uk',
      groupAvatarOverrides: { [String(group.id)]: null },
      personAvatarOverrides: { [String(group.id)]: { kind: 'emoji', emoji: '🦊' } },
    } });
    await page.goto(`/?project=${project.id}&tab=settings`);
    const groupSettings = page.getByTestId('group-avatar-settings');
    await expect(groupSettings).toBeVisible();
    await groupSettings.getByTestId('group-avatar-upload').setInputFiles({ name: 'group.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(groupSettings.locator('.notice-error')).toContainText('PNG, JPEG або WebP');

    let failGroupPhotoSettingsPatch = true;
    await page.route('**/api/settings', async route => {
      if (failGroupPhotoSettingsPatch && route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON() as { groupAvatarOverrides?: Record<string, { kind?: string }> };
        if (patch.groupAvatarOverrides?.[String(group.id)]?.kind === 'photo') {
          failGroupPhotoSettingsPatch = false;
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_SETTINGS_FAILURE', message: 'Mocked settings save failure.' }) });
          return;
        }
      }
      await route.continue();
    });
    const failedUpload = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/groups/${group.id}/avatar`);
    await groupSettings.getByTestId('group-avatar-upload').setInputFiles({ name: 'failed-group.png', mimeType: 'image/png', buffer: tinyPng });
    const failedUploadResponse = await failedUpload;
    const failedUploadUrl = (await failedUploadResponse.json() as { url: string }).url;
    await expect(groupSettings.locator('.notice-error')).toBeVisible();
    expect((await (await request.get('/api/settings')).json()).groupAvatarOverrides[String(group.id)]).toBeUndefined();
    await expect.poll(async () => (await request.get(failedUploadUrl)).status()).toBe(404);
    await page.unroute('**/api/settings');

    await groupSettings.getByTestId('group-avatar-upload').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: tinyPng });
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).groupAvatarOverrides[String(group.id)]?.kind).toBe('photo');
    const photoUrl = (await (await request.get('/api/settings')).json()).groupAvatarOverrides[String(group.id)].url as string;
    expect(photoUrl).toMatch(/^\/api\/groups\/2\/avatar\?v=/);
    expect((await request.get(photoUrl)).ok()).toBe(true);
    expect((await (await request.get('/api/settings')).json()).personAvatarOverrides[String(group.id)]).toEqual({ kind: 'emoji', emoji: '🦊' });

    await page.reload();
    await expect(page.getByTestId('group-avatar-preview').locator('.group-avatar img')).toHaveAttribute('src', photoUrl);
    await page.goto(`/?project=${project.id}`);
    const card = page.getByTestId(`issue-card-${issue.id}`);
    await expect(card.locator('.group-avatar img')).toHaveAttribute('src', photoUrl);
    await card.click();
    const dialog = page.getByTestId('issue-dialog');
    const assignee = dialog.locator('.assignee-avatar-picker');
    await expect(assignee.locator('.group-avatar img')).toHaveAttribute('src', photoUrl);
    await assignee.click();
    const groupOption = page.locator(`[data-value="group:${group.id}"]`);
    const personOption = page.locator(`[data-value="user:${group.id}"]`);
    await expect(groupOption.locator('.group-avatar img')).toHaveAttribute('src', photoUrl);
    await expect(personOption.locator('.avatar-local-emoji')).toHaveText('🦊');

    await page.keyboard.press('Escape');
    await page.goto(`/?project=${project.id}&tab=settings`);
    const reloadedSettings = page.getByTestId('group-avatar-settings');
    await reloadedSettings.locator('.theme-options[role="group"] button').filter({ hasText: '🌈' }).click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).groupAvatarOverrides[String(group.id)]).toEqual({ kind: 'emoji', emoji: '🌈' });
    await expect.poll(async () => (await request.get(photoUrl)).status()).toBe(404);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides[String(group.id)]).toEqual({ kind: 'emoji', emoji: '🦊' });

    await page.reload();
    await expect(page.getByTestId('group-avatar-preview').locator('.group-avatar')).toContainText('🌈');
    await page.getByTestId('group-avatar-remove').click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).groupAvatarOverrides[String(group.id)]).toBeUndefined();
    await page.reload();
    await expect(page.getByTestId('group-avatar-preview').locator('.group-avatar svg')).toBeVisible();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).personAvatarOverrides[String(group.id)]).toEqual({ kind: 'emoji', emoji: '🦊' });
  } finally {
    await request.patch('/api/settings', { data: {
      locale: previous.locale,
      groupAvatarOverrides: { [String(group.id)]: previousGroup },
      personAvatarOverrides: { [String(group.id)]: previousPerson },
    } });
  }
});
