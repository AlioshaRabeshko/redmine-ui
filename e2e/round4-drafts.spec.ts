import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { Bootstrap, CommandResult, Issue, IssueDetail } from '../src/shared/types.js';
import { editDescriptionSource } from './helpers/rich-editor.js';

async function bootstrap(request: APIRequestContext): Promise<Bootstrap> {
  await request.patch('/api/settings', { data: { locale: 'uk', theme: 'light' } });
  return await (await request.get('/api/bootstrap')).json() as Bootstrap;
}

async function createIssue(request: APIRequestContext, boot: Bootstrap): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject: `Round four text race ${Date.now()}`, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

test('an issue refresh during a held text-save response preserves newer unsaved description text', async ({ page, request }) => {
  const boot = await bootstrap(request);
  const issue = await createIssue(request, boot);
  await page.addInitScript(id => localStorage.setItem('redmine-workspace:project', String(id)), boot.projects[0]!.id);
  await page.route('**/api/events', route => route.abort());
  await page.goto('/');
  const card = page.getByTestId(`issue-card-${issue.id}`);
  await expect(card).toBeVisible();
  await card.click();
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const textarea = await editDescriptionSource(page);
  await textarea.fill('Submitted description');

  let releaseCommandResponse!: () => void;
  const commandResponseHeld = new Promise<void>(resolve => { releaseCommandResponse = resolve; });
  let commandReachedServer!: () => void;
  const commandCaught = new Promise<void>(resolve => { commandReachedServer = resolve; });
  await page.route('**/api/commands', async (route: Route) => {
    const response = await route.fetch();
    commandReachedServer();
    await commandResponseHeld;
    await route.fulfill({ response });
  });

  await page.keyboard.press('Meta+s');
  await commandCaught;

  let issueRefreshCount = 0;
  let issueRefreshCompleted!: () => void;
  const issueRefresh = new Promise<void>(resolve => { issueRefreshCompleted = resolve; });
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    if (detail.issue.description === 'Submitted description') {
      issueRefreshCount += 1;
      issueRefreshCompleted();
    }
    await route.fulfill({ response, json: detail });
  });
  const priorReads = issueRefreshCount;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await issueRefresh;
  expect(issueRefreshCount).toBeGreaterThan(priorReads);

  await textarea.fill('Newer description typed during save');
  releaseCommandResponse();
  await expect(dialog.locator('.text-save-row')).toBeVisible();
  await expect(textarea).toHaveValue('Newer description typed during save');
  await expect(dialog.getByRole('button', { name: 'Зберегти зміни', exact: true })).toBeEnabled();
  expect((await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail).issue.description).toBe('Submitted description');

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await card.click();
  await expect(await editDescriptionSource(page)).toHaveValue('Newer description typed during save');
});
