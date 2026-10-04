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
