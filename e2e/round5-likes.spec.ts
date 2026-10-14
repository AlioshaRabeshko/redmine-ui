import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, Command, CommandResult, IssueDetail } from '../src/shared/types.js';

type SeededJournal = { boot: Bootstrap; issueId: number; projectId: number; journalId: number };

async function seedComment(request: APIRequestContext, suffix: string): Promise<SeededJournal> {
  await request.patch('/api/settings', { data: { locale: 'uk', theme: 'light', palette: 'blue' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const issueResponse = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject: `Round five likes ${suffix}`, statusId: boot.statuses.find(status => status.key === 'todo')!.id },
  } });
  expect(issueResponse.ok()).toBe(true);
  const issue = (await issueResponse.json() as CommandResult).issue!;
  const notes = `Journal like fixture ${suffix}`;
  const commentResponse = await request.post('/api/commands', { data: {
    type: 'comment', issueId: issue.id, input: { notes },
  } });
  expect(commentResponse.ok()).toBe(true);
  const detail = await readIssue(request, issue.id);
  const journal = detail.journals.find(item => item.notes === notes);
  expect(journal).toBeTruthy();
  return { boot, issueId: issue.id, projectId: issue.projectId, journalId: journal!.id };
}

async function readIssue(request: APIRequestContext, issueId: number): Promise<IssueDetail> {
  const response = await request.get(`/api/issues/${issueId}`);
  expect(response.ok()).toBe(true);
  return await response.json() as IssueDetail;
}

async function openIssue(page: Page, fixture: SeededJournal) {
  await page.goto(`/?project=${fixture.projectId}&issue=${fixture.issueId}`);
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
}

function captureLikeCommands(page: Page): Command[] {
  const commands: Command[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/commands') && request.method() === 'POST') {
      const command = request.postDataJSON() as Command;
      if (command.type === 'setJournalLike') commands.push(command);
    }
  });
  return commands;
}

async function useRedmineBootstrap(page: Page, overrides: {
  canWrite: boolean; readOnly?: boolean; journalLikes: boolean;
}) {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const boot = await response.json() as Bootstrap;
    await route.fulfill({ response, json: {
      ...boot, mode: 'redmine', readOnly: overrides.readOnly ?? !overrides.canWrite, connected: true,
      capabilities: { ...boot.capabilities, canWrite: overrides.canWrite, journalLikes: overrides.journalLikes },
    } });
  });
}

async function rewriteJournal(page: Page, issueId: number, journalId: number,
  transform: (journal: IssueDetail['journals'][number]) => IssueDetail['journals'][number]) {
  await page.route(url => url.pathname === `/api/issues/${issueId}`, async route => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    await route.fulfill({ response, json: {
      ...detail,
      journals: detail.journals.map(journal => journal.id === journalId ? transform(journal) : journal),
    } });
  });
}

test('unverified Redmine like capability keeps the action unavailable and sends no command', async ({ page, request }) => {
  const fixture = await seedComment(request, `${Date.now()}-unsupported`);
  await useRedmineBootstrap(page, { canWrite: true, journalLikes: false });
  await rewriteJournal(page, fixture.issueId, fixture.journalId, journal => ({
    ...journal, canLike: false, likedByMe: false, likes: 0,
  }));
  const commands = captureLikeCommands(page);
  await openIssue(page, fixture);
  const item = page.getByTestId(`journal-item-${fixture.journalId}`);
  await expect(item.getByTestId(`journal-like-${fixture.journalId}`)).toHaveCount(0);
  await expect(item.getByTestId(`journal-quote-${fixture.journalId}`)).toBeVisible();
  await expect(item.getByTestId(`journal-permalink-${fixture.journalId}`)).toBeVisible();
  expect(commands).toHaveLength(0);
  const stored = (await readIssue(request, fixture.issueId)).journals.find(journal => journal.id === fixture.journalId)!;
  expect({ likedByMe: stored.likedByMe, likes: stored.likes }).toEqual({ likedByMe: false, likes: 0 });
});

test('read-only Redmine hides the unsupported like action without changing local state', async ({ page, request }) => {
  const fixture = await seedComment(request, `${Date.now()}-readonly`);
  await useRedmineBootstrap(page, { canWrite: false, readOnly: true, journalLikes: false });
  await rewriteJournal(page, fixture.issueId, fixture.journalId, journal => ({
    ...journal, canLike: false, likedByMe: false, likes: 0,
  }));
  const commands = captureLikeCommands(page);
  await openIssue(page, fixture);
  const like = page.getByTestId(`journal-like-${fixture.journalId}`);
  await expect(like).toHaveCount(0);
  expect(commands).toHaveLength(0);
  const stored = (await readIssue(request, fixture.issueId)).journals.find(journal => journal.id === fixture.journalId)!;
  expect({ likedByMe: stored.likedByMe, likes: stored.likes }).toEqual({ likedByMe: false, likes: 0 });
});
