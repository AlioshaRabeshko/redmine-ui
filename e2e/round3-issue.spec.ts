import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { BoardData, Bootstrap, CommandResult, Issue, IssueDetail, Journal } from '../src/shared/types.js';

async function createDemoIssue(request: APIRequestContext, boot: Bootstrap, subject: string, input: Record<string, unknown> = {}): Promise<Issue> {
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: { subject, statusId: boot.statuses.find(status => status.key === 'todo')!.id, ...input },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json() as CommandResult).issue!;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unexpected computed color: ${color}`);
    const [red, green, blue] = channels.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

async function installLongActivityFixture(page: Page, issue: Issue, boot: Bootstrap) {
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    const activity: Journal[] = Array.from({ length: 14 }, (_, index) => ({
      id: 4_000_000 + issue.id * 20 + index,
      user: boot.me,
      createdOn: new Date(Date.now() - index * 60_000).toISOString(),
      notes: `Synthetic issue activity ${index + 1}. This text makes the activity pane long enough to verify its independent scroll behavior.`,
      changes: [],
      ...(index === 0 ? { canEdit: true } : {}),
    }));
    await route.fulfill({ response, json: { ...detail, journals: [...detail.journals, ...activity] } });
  });
}

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { locale: 'en', theme: 'light' } });
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
});

test('issue header stays compact and sticky, hidden menu items do not enter the focus trap, and activity controls stay above journals', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const subject = `Sticky issue heading ${'long subject '.repeat(7)}${'withoutbreaks'.repeat(5)}`;
  const issue = await createDemoIssue(request, boot, subject, { description: 'A description for typography and preview checks.' });
  await installLongActivityFixture(page, issue, boot);

  await page.goto(`/?project=${issue.projectId}&q=${encodeURIComponent(subject)}`);
  const card = page.getByTestId(`issue-card-${issue.id}`);
  await expect(card).toBeVisible();
  const opener = card.locator('.card-open-action');
  await opener.click();

  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeFocused();
  await expect(dialog.locator('.issue-toolbar')).toHaveCount(0);
  await expect(dialog.locator('.issue-dialog-footer')).toHaveCount(0);
  await expect(dialog.locator('.issue-heading-line')).toContainText(`Feature #${issue.id}`);
  await expect(dialog.locator('.issue-heading-subject')).toHaveText(subject);
  expect(await dialog.locator('.issue-dialog-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  const menu = dialog.locator('.issue-header-menu');
  const menuSummary = menu.locator('summary');
  await expect(menu.locator('button')).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expect(menuSummary).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await menuSummary.click();
  const copy = menu.getByRole('button', { name: 'Copy Redmine URL', exact: true });
  const open = menu.getByRole('link', { name: 'Open in Redmine', exact: true });
  await expect(copy).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('href', new RegExp(`/issues/${issue.id}$`));
  await menuSummary.click();

  const scroll = dialog.locator('.issue-dialog-scroll');
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const startTop = await dialog.locator('.modal-heading').evaluate(element => element.getBoundingClientRect().top);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const endTop = await dialog.locator('.modal-heading').evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(endTop - startTop)).toBeLessThan(1);
  await expect(close).toBeVisible();
  expect(await dialog.locator('.modal-heading').evaluate(element => getComputedStyle(element).position)).toBe('sticky');

  const toolbar = dialog.getByTestId('activity-toolbar');
  await expect(toolbar.getByTestId('activity-filter-controls')).toBeVisible();
  expect(await dialog.evaluate(element => {
    const composer = element.querySelector('.comment-composer')!;
    const list = element.querySelector('.activity-list')!;
    return Boolean(composer.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(dialog.locator('.description-area')).toHaveCSS('font-size', '13px');
  await expect(dialog.getByTestId('comment-composer')).toHaveCSS('font-size', '13px');
  await expect(dialog.locator('.activity-rich-content').first()).toHaveCSS('font-size', '12px');

  const editButton = dialog.getByTestId(`journal-edit-${4_000_000 + issue.id * 20}`);
  await editButton.click();
  await expect(dialog.getByTestId(`journal-editor-textarea-${4_000_000 + issue.id * 20}`)).toHaveCSS('font-size', '13px');
  await dialog.getByTestId(`journal-cancel-${4_000_000 + issue.id * 20}`).click();

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test('Due Date still submits with the associated text form, label tiles support keyboard autosave, and initials colors meet contrast in both themes', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const legacyLabel = `Round three legacy ${Date.now()}`;
  const issue = await createDemoIssue(request, boot, `Issue form and labels ${Date.now()}`, { labels: [legacyLabel] });
  const initialDueDate = '2026-10-20';
  const seededDate = await request.post('/api/commands', { data: {
    type: 'updateIssue', issueId: issue.id, input: { dueDate: initialDueDate },
  } });
  expect(seededDate.ok()).toBe(true);
  let boardCatalogIncludesLegacy = true;
  await page.route(url => url.pathname === `/api/projects/${issue.projectId}/board`, async route => {
    const response = await route.fetch();
    const board = await response.json() as BoardData;
    const catalogLabels = Array.from({ length: 15 }, (_, index) => `Round three catalog ${index + 1}`);
    const fixtureBoard = {
      ...board,
      labels: [...new Set([...board.labels.filter(label => label !== legacyLabel), ...catalogLabels])],
      labelOptions: board.labelOptions?.filter(option => option.name !== legacyLabel),
    };
    boardCatalogIncludesLegacy = fixtureBoard.labels.includes(legacyLabel) || (fixtureBoard.labelOptions || []).some(option => option.name === legacyLabel);
    await route.fulfill({
      response,
      json: fixtureBoard,
    });
  });
  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  expect(boardCatalogIncludesLegacy).toBe(false);
  const legacyTile = dialog.getByRole('button', { name: legacyLabel, exact: true });
  await expect(legacyTile).toBeVisible();
  await expect(legacyTile).toHaveAttribute('aria-pressed', 'true');

  const dueDate = dialog.getByTestId('issue-due-date');
  const dueFormAssociation = await dueDate.evaluate(element => ({
    formId: (element as HTMLInputElement).form?.id,
    closestForm: Boolean(element.closest('form')),
  }));
  expect(dueFormAssociation).toEqual({ formId: `issue-text-form-${issue.id}`, closestForm: false });

  await expect(dueDate).toHaveValue(initialDueDate);
  const description = dialog.locator('.description-area');
  const descriptionOnly = 'Editing description leaves the existing due date unchanged.';
  await description.fill(descriptionOnly);
  await expect(dialog.locator('.text-save-row')).toBeVisible();
  const descriptionSaveRequest = page.waitForRequest(request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/commands') return false;
    const command = request.postDataJSON() as { type?: string; issueId?: number };
    return command.type === 'updateIssue' && command.issueId === issue.id;
  });
  await page.keyboard.press('Control+s');
  const descriptionCommand = (await descriptionSaveRequest).postDataJSON() as { input: Record<string, unknown> };
  expect(descriptionCommand.input).toMatchObject({ description: descriptionOnly });
  expect(descriptionCommand.input).not.toHaveProperty('dueDate');
  await expect.poll(async () => {
    const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
    return { description: detail.issue.description, dueDate: detail.issue.dueDate };
  }).toEqual({ description: descriptionOnly, dueDate: initialDueDate });
  await expect(dialog.locator('.text-save-row')).not.toBeVisible();

  const combinedDescription = 'Description and date are saved in one focused form submission.';
  await description.fill(combinedDescription);
  await dueDate.fill('2026-12-31');
  await expect(dialog.locator('.text-save-row')).toBeVisible();
  const combinedSaveRequest = page.waitForRequest(request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/commands') return false;
    const command = request.postDataJSON() as { type?: string; issueId?: number };
    return command.type === 'updateIssue' && command.issueId === issue.id;
  });
  await page.keyboard.press('Control+s');
  const combinedCommand = (await combinedSaveRequest).postDataJSON() as { input: Record<string, unknown> };
  expect(combinedCommand.input).toMatchObject({ description: combinedDescription, dueDate: '2026-12-31' });
  await expect.poll(async () => {
    const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
    return { description: detail.issue.description, dueDate: detail.issue.dueDate };
  }).toEqual({ description: combinedDescription, dueDate: '2026-12-31' });
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.getByTestId('issue-due-date')).toHaveValue('2026-12-31');
  await expect(page.getByTestId('issue-dialog').locator('.description-area')).toHaveValue(combinedDescription);

  const labelToggle = dialog.locator('.labels-catalog-toggle');
  await expect(labelToggle).toBeVisible();
  await labelToggle.click();
  const search = dialog.locator('.labels-catalog-search input');
  await search.fill('Build:');
  const tiles = dialog.locator('.label-tile');
  await expect(tiles).toHaveCount(3);
  const firstTile = tiles.nth(0);
  const secondTile = tiles.nth(1);
  await firstTile.focus();
  await page.keyboard.press('ArrowRight');
  await expect(secondTile).toBeFocused();
  const selectedLabel = await secondTile.getAttribute('data-label-value');
  await page.keyboard.press('Space');
  await expect(secondTile).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
    return detail.issue.labels;
  }).toContain(selectedLabel);
  await search.fill('');
  await expect(legacyTile).toBeVisible();
  await expect(legacyTile).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
    return detail.issue.labels;
  }).toContain(legacyLabel);

  const authorAvatar = dialog.locator('.people-section .person-row .avatar-fallback-color').first();
  const lightAvatar = await authorAvatar.evaluate(element => ({
    id: element.getAttribute('data-person-id'),
    background: getComputedStyle(element).backgroundColor,
    foreground: getComputedStyle(element).color,
  }));
  expect(lightAvatar.id).toBe(String(boot.me.id));
  expect(contrastRatio(lightAvatar.foreground, lightAvatar.background)).toBeGreaterThanOrEqual(4.5);

  await request.patch('/api/settings', { data: { theme: 'dark' } });
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  const darkAvatar = page.getByTestId('issue-dialog').locator('.people-section .person-row .avatar-fallback-color').first();
  const darkColors = await darkAvatar.evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    foreground: getComputedStyle(element).color,
  }));
  expect(contrastRatio(darkColors.foreground, darkColors.background)).toBeGreaterThanOrEqual(4.5);
  expect(darkColors.background).not.toBe(lightAvatar.background);
  await page.reload();
  await expect(page.getByTestId('issue-dialog')).toBeVisible();
  await expect(page.getByTestId('issue-dialog').locator('.people-section .person-row .avatar-fallback-color').first()).toHaveCSS('background-color', darkColors.background);
});

test('sending an own comment does not reveal an older buffered event with the same author and text', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Buffered own comment ${Date.now()}`);
  const notes = 'A deliberate duplicate note for the buffering race';
  const bufferedId = 7_000_000 + issue.id;
  let addBufferedEvent = false;
  await page.route('**/api/events', route => route.abort());
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, async (route: Route) => {
    const response = await route.fetch();
    const detail = await response.json() as IssueDetail;
    const journals = addBufferedEvent ? [...detail.journals, {
      id: bufferedId, user: boot.me, createdOn: new Date().toISOString(), notes, changes: [],
    }] : detail.journals;
    await route.fulfill({ response, json: { ...detail, journals } });
  });

  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  addBufferedEvent = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog.getByTestId('activity-new-events')).toBeVisible();
  await expect(dialog.getByTestId(`journal-item-${bufferedId}`)).toHaveCount(0);

  await dialog.getByTestId('comment-composer').fill(notes);
  await dialog.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(dialog.locator('.activity-item').filter({ hasText: notes })).toHaveCount(1);
  await expect(dialog.getByTestId(`journal-item-${bufferedId}`)).toHaveCount(0);
  await expect(dialog.getByTestId('show-new-activity')).toContainText('1');

  await dialog.getByTestId('show-new-activity').click();
  await expect(dialog.getByTestId(`journal-item-${bufferedId}`)).toBeVisible();
  await expect(dialog.locator('.activity-item').filter({ hasText: notes })).toHaveCount(2);
});

test('keyboard reveal keeps focus in Activity and preserves the draft and visible journal anchor', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Keyboard activity reveal ${Date.now()}`);
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const anchorJournalId = 7_100_000 + issue.id;
  const incomingJournalId = 7_200_000 + issue.id;
  const anchorJournal: Journal = {
    id: anchorJournalId, user: boot.me, createdOn: '2026-10-04T09:00:00.000Z',
    notes: 'Previously visible activity anchor', changes: [],
  };
  const incomingJournal: Journal = {
    id: incomingJournalId, user: boot.me, createdOn: '2026-10-05T09:00:00.000Z',
    notes: 'Buffered keyboard reveal event', changes: [],
  };
  let latestDetail: IssueDetail = { ...detail, journals: [anchorJournal] };
  await page.route('**/api/events', route => route.abort());
  await page.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: latestDetail }));

  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  const comment = dialog.getByTestId('comment-composer');
  const draft = 'Keep this draft and the visible activity position';
  await comment.fill(draft);
  await expect(dialog.getByTestId('draft-persistence-status')).toBeVisible();
  const anchor = dialog.getByTestId(`journal-item-${anchorJournalId}`);
  await expect(anchor).toBeVisible();
  await anchor.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const revealSlot = dialog.getByTestId('activity-new-events-slot');
  const slotHeightBeforeArrival = await revealSlot.evaluate(element => element.getBoundingClientRect().height);
  const anchorTopBeforeArrival = await anchor.evaluate(element => element.getBoundingClientRect().top);

  latestDetail = { ...latestDetail, journals: [...latestDetail.journals, incomingJournal] };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog.getByTestId('activity-new-events')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId(`journal-item-${incomingJournalId}`)).toHaveCount(0);
  await expect(comment).toHaveValue(draft);
  const slotHeightAfterArrival = await revealSlot.evaluate(element => element.getBoundingClientRect().height);
  expect(Math.abs(slotHeightAfterArrival - slotHeightBeforeArrival)).toBeLessThan(1);
  const anchorTopAfterArrival = await anchor.evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(anchorTopAfterArrival - anchorTopBeforeArrival)).toBeLessThan(1);
  const anchorTopBeforeReveal = await anchor.evaluate(element => element.getBoundingClientRect().top);

  const showEvents = dialog.getByTestId('show-new-activity');
  await showEvents.focus();
  await expect(showEvents).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('activity-new-events')).toHaveCount(0);
  await expect(dialog.getByTestId(`journal-item-${incomingJournalId}`)).toBeVisible();
  await expect(dialog.locator('.activity-toolbar-heading h3')).toBeFocused();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expect(comment).toHaveValue(draft);
  const anchorTopAfterReveal = await anchor.evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(anchorTopAfterReveal - anchorTopBeforeReveal)).toBeLessThan(1);
});

test('a remote comment submit does not erase another tab\'s unsent comment draft', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const issue = await createDemoIssue(request, boot, `Cross-tab comment draft ${Date.now()}`);
  const detail = await (await request.get(`/api/issues/${issue.id}`)).json() as IssueDetail;
  const context = page.context();
  await context.route('**/api/events', route => route.abort());
  await context.route(url => url.pathname === `/api/issues/${issue.id}`, route => route.fulfill({ json: detail }));

  await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  const firstDialog = page.getByTestId('issue-dialog');
  await expect(firstDialog).toBeVisible();
  const firstComment = firstDialog.getByTestId('comment-composer');
  const firstDraft = 'Unsent text owned by the first tab';
  await firstComment.fill(firstDraft);
  await expect(firstDialog.getByTestId('draft-persistence-status')).toBeVisible();

  const secondPage = await context.newPage();
  await secondPage.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
  const secondDialog = secondPage.getByTestId('issue-dialog');
  await expect(secondDialog).toBeVisible();
  const secondComment = secondDialog.getByTestId('comment-composer');
  await expect(secondComment).toHaveValue(firstDraft);
  const sentFromSecondTab = 'A different comment submitted from the second tab';
  await secondComment.fill(sentFromSecondTab);
  await expect(firstComment).toHaveValue(firstDraft);
  await secondDialog.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(secondComment).toHaveValue('');
  await expect(secondDialog.getByTestId('draft-persistence-status')).toHaveCount(0);
  await secondPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  await expect(firstComment).toHaveValue(firstDraft);
  const commentStorageKey = ['redmine-workspace', 'issue-draft', `${boot.mode}:${boot.redmineUrl}:${boot.me.id}`, String(issue.projectId), String(issue.id), 'comment']
    .map(value => encodeURIComponent(value)).join(':');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), commentStorageKey)).toBe(firstDraft);

  await page.keyboard.press('Escape');
  await expect(firstDialog).not.toBeVisible();
  await page.getByTestId(`issue-card-${issue.id}`).click();
  const reopenedDialog = page.getByTestId('issue-dialog');
  await expect(reopenedDialog).toBeVisible();
  await expect(reopenedDialog.getByTestId('comment-composer')).toHaveValue(firstDraft);
});

test('long Settings content scrolls inside the workspace while the sidebar and header stay in the viewport', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await page.goto(`/?project=${boot.projects[0]!.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const pane = page.locator('.content-scroll');
  const before = await pane.evaluate(element => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  await pane.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const shell = await page.evaluate(() => ({
    pageScroll: window.scrollY,
    topbarTop: document.querySelector('.topbar')!.getBoundingClientRect().top,
    sidebarTop: document.querySelector('.sidebar')!.getBoundingClientRect().top,
    viewportHeight: window.innerHeight,
    shellBottom: document.querySelector('.app-frame')!.getBoundingClientRect().bottom,
  }));
  expect(shell.pageScroll).toBe(0);
  expect(Math.abs(shell.topbarTop)).toBeLessThan(1);
  expect(Math.abs(shell.sidebarTop)).toBeLessThan(1);
  expect(shell.shellBottom).toBeLessThanOrEqual(shell.viewportHeight + 1);
});
