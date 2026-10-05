import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { BoardData, Bootstrap, Issue, Person, Version } from '../src/shared/types.js';

const baseId = 700_000;
const versionIds = { first: 72_001, second: 72_002, closed: 72_003 };

async function installBoardFixture(page: Page, request: APIRequestContext, readOnly = false) {
  const bootstrapResponse = await request.get('/api/bootstrap');
  const bootstrap = await bootstrapResponse.json() as Bootstrap;
  expect(bootstrap.mode).toBe('demo');
  const project = bootstrap.projects[0];
  const originalBoard = await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData;
  const template = originalBoard.issues[0];
  expect(template).toBeTruthy();

  const statuses = bootstrap.statuses;
  const todo = statuses.find(status => status.key === 'todo')!;
  const review = statuses.find(status => status.key === 'review')!;
  const deploy = statuses.find(status => status.key === 'deploy')!;
  const priorityForRank = (rank: number) => bootstrap.priorities.find(priority => priority.rank === rank)?.id ?? bootstrap.priorities[0].id;
  const highestPriority = [...bootstrap.priorities].sort((left, right) => right.rank - left.rank)[0];
  const members: Person[] = [
    { id: 97_001, name: 'Sam Support', roles: ['support'] },
    { id: 97_002, name: 'Dee Developer', roles: ['developer', 'support'] },
    { id: 97_003, name: 'Quinn QA', roles: ['qa'] },
  ];
  const makeIssue = (id: number, statusId: number, fixedVersionId?: number, priorityId = priorityForRank(2)): Issue => ({
    ...template,
    id,
    projectId: project.id,
    subject: `Board audit ${id}`,
    description: '',
    statusId,
    priorityId,
    assignedToId: members[0].id,
    developerId: members[1].id,
    qaId: members[2].id,
    fixedVersionId,
    branch: `audit/${id}`,
    labels: ['Build: Running', 'Accessibility', 'Backend', 'Needs review'],
    watcherIds: [],
    createdOn: '2026-10-01',
    updatedOn: '2026-10-04',
    dueDate: undefined,
    attachments: [],
  });
  const versions: Version[] = [
    { id: versionIds.first, projectId: project.id, name: 'Blue release', status: 'open' },
    { id: versionIds.second, projectId: project.id, name: 'Violet release', status: 'locked' },
    { id: versionIds.closed, projectId: project.id, name: 'Closed release', status: 'closed' },
  ];
  const issues = [
    makeIssue(baseId + 1, todo.id, versionIds.first, priorityForRank(1)),
    makeIssue(baseId + 2, todo.id, undefined, highestPriority.id),
    makeIssue(baseId + 3, review.id, versionIds.second, priorityForRank(4)),
    makeIssue(baseId + 4, deploy.id, versionIds.first, priorityForRank(3)),
    makeIssue(baseId + 5, deploy.id, versionIds.second, priorityForRank(2)),
    makeIssue(baseId + 6, deploy.id, versionIds.closed, priorityForRank(3)),
    ...Array.from({ length: 26 }, (_, index) => makeIssue(baseId + 100 + index, todo.id)),
  ];
  const board: BoardData = { ...originalBoard, issues, versions, members, total: issues.length };

  await page.route('**/api/bootstrap', async route => {
    const current = await route.fetch();
    const value = await current.json() as Bootstrap;
    await route.fulfill({ json: {
      ...value,
      statuses: value.statuses.map(status => status.key === 'deploy' ? { ...status, isClosed: true } : status),
      ...(readOnly ? { mode: 'redmine', readOnly: true, capabilities: { ...value.capabilities, canWrite: false } } : {}),
    } });
  });
  await page.route(`**/api/projects/${project.id}/board*`, route => route.fulfill({ json: board }));
  return { project, statuses: { todo, review, deploy }, issues, board, highestPriority };
}

test('release columns show Deploy only, pin other members, and keep Deploy visible when closed', async ({ page, request }) => {
  const fixture = await installBoardFixture(page, request);
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();

  const todoLane = page.getByTestId(`lane-status:${fixture.statuses.todo.id}`);
  await expect(todoLane.locator('.lane-content .issue-card').first()).toHaveAttribute('data-issue-id', String(baseId + 1));
  await expect(todoLane.locator('.lane-content .issue-card').nth(1)).toHaveAttribute('data-issue-id', String(baseId + 2));
  await expect(page.getByTestId(`lane-version:${versionIds.first}`).getByTestId(`issue-card-${baseId + 4}`)).toBeVisible();
  await expect(page.getByTestId(`lane-version:${versionIds.second}`).getByTestId(`issue-card-${baseId + 5}`)).toBeVisible();
  await expect(page.getByTestId(`lane-status:${fixture.statuses.review.id}`).getByTestId(`issue-card-${baseId + 3}`)).toBeVisible();
  await expect(page.getByTestId(`lane-status:${fixture.statuses.deploy.id}`).getByTestId(`issue-card-${baseId + 6}`)).toBeVisible();
  await expect(page.getByTestId(`lane-version:${versionIds.closed}`)).toHaveCount(0);

  const visibleIds = await page.locator('[data-testid^="issue-card-"]').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue-id')));
  expect(new Set(visibleIds).size).toBe(visibleIds.length);
  await expect(page.locator('.branch-row')).toHaveCount(0);
  await expect(page.getByTestId(`issue-card-${baseId + 2}`).locator('.actual-status')).toHaveCount(0);
  await expect(page.getByTestId(`issue-card-${baseId + 2}`).locator('.priority-mark')).toContainText(fixture.highestPriority.name);
  await expect(page.getByTestId(`issue-card-${baseId + 2}`).locator('.label-chip')).toHaveCount(3);
  await expect(page.getByTestId(`issue-card-${baseId + 2}`).locator('.label-more')).toHaveText('+1');
  const card = page.getByTestId(`issue-card-${baseId + 2}`);
  const assigneeAvatar = card.locator('.person-stack .avatar');
  const developerAvatar = card.locator('.person-mini:not(.qa-mini):not(.author-mini) .avatar');
  const qaAvatar = card.locator('.qa-mini .avatar');
  await expect(assigneeAvatar).toHaveClass(/avatar-role-support/);
  await expect(assigneeAvatar).toHaveClass(/avatar-md/);
  await expect(assigneeAvatar).toHaveAttribute('aria-label', /Sam Support · .+/);
  await expect(developerAvatar).toHaveClass(/avatar-role-developer/);
  await expect(developerAvatar).toHaveClass(/avatar-multiple-roles/);
  await expect(developerAvatar).toHaveAttribute('aria-label', /Dee Developer · .+ · .+/);
  await expect(qaAvatar).toHaveClass(/avatar-role-qa/);
  await expect(qaAvatar).toHaveAttribute('aria-label', /Quinn QA · .+/);
  expect(await assigneeAvatar.evaluate(element => getComputedStyle(element).clipPath)).toContain('polygon');
  expect(await assigneeAvatar.evaluate(element => getComputedStyle(element).borderRadius)).toBe('0px');
  expect(await developerAvatar.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('7px');
  expect(await qaAvatar.evaluate(element => getComputedStyle(element).borderRadius)).toBe('50%');
  await expect(page.locator(`.lane-roadmap.${'release-tone-' + (versionIds.first % 6)}`)).toHaveCount(1);
});

test('each lane scrolls independently and headers stay fixed in read-only mode', async ({ page, request }) => {
  const fixture = await installBoardFixture(page, request, true);
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('new-issue')).toBeDisabled();
  await expect(page.locator('.lane-create:enabled')).toHaveCount(0);

  const firstLane = page.getByTestId(`lane-status:${fixture.statuses.todo.id}`);
  const secondLane = page.getByTestId(`lane-status:${fixture.statuses.review.id}`);
  const firstScroll = firstLane.locator('.lane-content');
  const secondScroll = secondLane.locator('.lane-content');
  const headerTop = (await firstLane.locator('.lane-header').boundingBox())!.y;
  await firstScroll.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => firstScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await secondScroll.evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.locator('.content-scroll').evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.locator('.board-scroll').evaluate(element => element.scrollTop)).toBe(0);
  expect((await firstLane.locator('.lane-header').boundingBox())!.y).toBe(headerTop);
});

test('short and empty lanes keep natural height, horizontal wheel reaches the board, and vertical wheel stays in its lane', async ({ page, request }) => {
  const fixture = await installBoardFixture(page, request);
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  const longLane = page.getByTestId(`lane-status:${fixture.statuses.todo.id}`);
  const shortLane = page.getByTestId(`lane-status:${fixture.statuses.review.id}`);
  const emptyLane = page.getByTestId(`lane-status:${boot.statuses.find(status => status.key === 'qa')!.id}`);
  const boardScroll = page.locator('.board-scroll');
  const longContent = longLane.locator('.lane-content');
  const shortContent = shortLane.locator('.lane-content');
  const emptyContent = emptyLane.locator('.lane-content');

  const longBox = await longLane.boundingBox();
  const shortBox = await shortLane.boundingBox();
  const emptyBox = await emptyLane.boundingBox();
  const emptyHeader = await emptyLane.locator('.lane-header').boundingBox();
  expect(longBox).not.toBeNull(); expect(shortBox).not.toBeNull(); expect(emptyBox).not.toBeNull(); expect(emptyHeader).not.toBeNull();
  expect(shortBox!.height).toBeLessThan(longBox!.height);
  expect(emptyBox!.height).toBeLessThan(longBox!.height);
  expect(emptyBox!.height - emptyHeader!.height).toBeGreaterThan(70); // Empty lanes retain a useful drop target.
  await expect(emptyLane.locator('.lane-create')).toBeVisible();
  await expect(emptyLane.locator('.lane-empty')).toBeVisible();
  expect(await longContent.evaluate(element => element.scrollHeight)).toBeGreaterThan(await longContent.evaluate(element => element.clientHeight));
  expect(await shortContent.evaluate(element => element.scrollHeight)).toBeLessThanOrEqual(await shortContent.evaluate(element => element.clientHeight) + 1);
  expect(await emptyContent.evaluate(element => element.scrollHeight)).toBeLessThanOrEqual(await emptyContent.evaluate(element => element.clientHeight) + 1);

  await longLane.locator('.issue-card').first().hover();
  await page.mouse.wheel(520, 0);
  await expect.poll(() => boardScroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await longContent.evaluate(element => element.scrollTop)).toBe(0);
  await boardScroll.evaluate(element => { element.scrollLeft = 0; });

  await longContent.hover();
  await page.mouse.wheel(0, 650);
  await expect.poll(() => longContent.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await shortContent.evaluate(element => element.scrollTop)).toBe(0);
  expect(await emptyContent.evaluate(element => element.scrollTop)).toBe(0);
  expect(await boardScroll.evaluate(element => element.scrollTop)).toBe(0);
});

test('project roles survive sparse issue people data and selected assignee stays framed on hover and keyboard focus', async ({ page, request }) => {
  const fixture = await installBoardFixture(page, request);
  const issue = fixture.issues[0]!;
  const support = fixture.board.members.find(person => person.id === 97_001)!;
  const qa = fixture.board.members.find(person => person.id === 97_003)!;
  issue.authorId = qa.id;
  issue.watcherIds = [support.id];
  await page.route(`**/api/issues/${issue.id}`, route => route.fulfill({ json: {
    issue,
    people: [{ id: support.id, name: support.name }, { id: qa.id, name: qa.name }],
    watchers: [{ id: support.id, name: support.name }],
    journals: [{ id: 97_099, user: { id: qa.id, name: qa.name }, notes: 'Role sourced activity', createdOn: '2026-10-04T10:00:00.000Z', changes: [] }],
  } }));
  await page.goto(`/?issue=${issue.id}`);
  const dialog = page.getByTestId('issue-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.watcher-list .avatar')).toHaveClass(/avatar-role-support/);
  await expect(dialog.getByTestId('journal-item-97099').locator('.avatar')).toHaveClass(/avatar-role-qa/);

  const selected = dialog.locator(`.assignee-avatar-option[data-person-id="${support.id}"]`);
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(selected.locator('.avatar')).toHaveClass(/avatar-role-support/);
  const hasVisibleSelection = async () => selected.evaluate(element => {
    const color = getComputedStyle(element, '::before').backgroundColor;
    return color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
  });
  expect(await hasVisibleSelection()).toBe(true);
  await selected.hover();
  expect(await hasVisibleSelection()).toBe(true);
  await selected.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await selected.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await expect(selected).toHaveCSS('outline-style', 'solid');
  expect(parseFloat(await selected.evaluate(element => getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(2);
});

test('login-style names keep two graphemes in the board avatar fallback', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const project = boot.projects[0]!;
  const board = await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData;
  const issue = board.issues[0]!;
  const person = board.members[0]!;
  issue.assignedToId = person.id;
  await page.route(`**/api/projects/${project.id}/board*`, async route => {
    const response = await route.fetch();
    const value = await response.json() as BoardData;
    const member = value.members.find(entry => entry.id === person.id)!;
    member.name = 'qa.bot';
    delete member.avatar;
    delete member.localEmoji;
    const target = value.issues.find(entry => entry.id === issue.id)!;
    target.assignedToId = person.id;
    await route.fulfill({ response, json: value });
  });
  await page.goto(`/?project=${project.id}`);
  const fallback = page.getByTestId(`issue-card-${issue.id}`).locator('.person-stack .avatar');
  await expect(fallback).toHaveAttribute('aria-label', /qa\.bot/);
  await expect(fallback.locator('.avatar-initials')).toHaveText('QA');
});

test('dragging to the edge autoscrolls the nested lane in demo mode', async ({ page, request }) => {
  const fixture = await installBoardFixture(page, request);
  let commandCount = 0;
  await page.route('**/api/commands', route => {
    commandCount++;
    return route.fulfill({ json: { operation: { id: 'board-audit-mock', type: 'moveIssue', status: 'done', steps: [], createdOn: '2026-10-04' } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  const lane = page.getByTestId(`lane-status:${fixture.statuses.todo.id}`);
  const scroll = lane.locator('.lane-content');
  const source = page.getByTestId(`issue-card-${baseId + 100}`).locator('.card-hit-area');
  const sourceBox = (await source.boundingBox())!;
  const scrollBox = (await scroll.boundingBox())!;

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2 + 12, { steps: 4 });
  const edgeX = scrollBox.x + scrollBox.width / 2;
  const edgeY = scrollBox.y + scrollBox.height - 10;
  await page.mouse.move(edgeX, edgeY, { steps: 12 });
  await expect.poll(() => scroll.evaluate(element => element.scrollTop), { timeout: 4_000 }).toBeGreaterThan(0);
  await page.mouse.up();

  expect(await page.locator('.content-scroll').evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.locator('.board-scroll').evaluate(element => element.scrollTop)).toBe(0);
  expect(commandCount).toBe(0);
});
