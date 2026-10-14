import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { BoardData, Bootstrap, CommandResult, Issue, Person } from '../src/shared/types.js';

const idBase = 810_000;

async function loadBootstrap(request: APIRequestContext): Promise<Bootstrap> {
  // Playwright reuses the demo server across scenarios. Reset view-local settings so
  // a collapsed lane or saved filter from an earlier test cannot mask later cards.
  await request.patch('/api/settings', { data: {
    locale: 'en', theme: 'light', palette: 'blue', collapsedBoardColumns: {}, savedViews: [], subscriptions: {},
  } });
  const value = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(value.mode).toBe('demo');
  return value;
}

async function installBoard(
  page: Page,
  request: APIRequestContext,
  issues: Issue[],
  withPriorities: (priorities: Bootstrap['priorities']) => Bootstrap['priorities'] = priorities => priorities,
) {
  const originalBoot = await loadBootstrap(request);
  const priorities = withPriorities(originalBoot.priorities);
  const boot: Bootstrap = { ...originalBoot, priorities };
  const project = boot.projects[0]!;
  const original = await (await request.get(`/api/projects/${project.id}/board`)).json() as BoardData;
  const member: Person = { id: idBase + 30, name: 'Watcher Example' };
  const initialIssues = issues.length ? issues : original.issues;
  let board: BoardData = { ...original, members: [...original.members, member], issues: initialIssues, total: initialIssues.length };
  await page.route(url => url.pathname === '/api/bootstrap', async route => {
    const response = await route.fetch();
    const current = await response.json() as Bootstrap;
    await route.fulfill({ response, json: { ...current, priorities, settings: { ...current.settings, locale: 'en', theme: 'light', palette: 'blue' } } });
  });
  await page.route(url => url.pathname === `/api/projects/${project.id}/board`, route => route.fulfill({ json: board }));
  return {
    boot, project, watcher: member,
    get board() { return board; },
    setBoard(patch: Partial<BoardData>) { board = { ...board, ...patch }; },
  };
}

async function openProjectBoard(page: Page, projectId: number) {
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByTestId('board')).toBeVisible();
}

test('watcher filter stays in URL and a saved view restores it', async ({ page, request }) => {
  const { boot, project, board, watcher, setBoard } = await installBoard(page, request, []);
  const todo = boot.statuses.find(status => status.key === 'todo')!;
  const makeIssue = (id: number, subject: string, watcherIds: number[]): Issue => ({
    ...board.issues[0]!, id, projectId: project.id, subject, statusId: todo.id,
    assignedToId: boot.me.id, watcherIds, labels: [], createdOn: '2026-10-01', updatedOn: '2026-10-01',
  });
  const target = makeIssue(idBase + 1, 'Watched card', [watcher.id]);
  const other = makeIssue(idBase + 2, 'Unwatched card', []);
  setBoard({ issues: [target, other], total: 2 });

  await openProjectBoard(page, project.id);
  await page.getByRole('button', { name: 'Filters' }).click();
  const watcherPicker = page.getByRole('combobox', { name: 'Watcher' });
  await watcherPicker.click();
  await page.getByRole('option', { name: /Watcher Example/ }).click();
  await expect(page.getByTestId(`issue-card-${target.id}`)).toBeVisible();
  await expect(page.getByTestId(`issue-card-${other.id}`)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('watcher')).toBe(String(watcher.id));

  // Selecting a picker option closes the outer filter popover too.
  const filtersButton = page.getByRole('button', { name: 'Filters' });
  if (await filtersButton.getAttribute('aria-expanded') !== 'true') await filtersButton.click();
  await page.getByRole('button', { name: 'Save filter' }).click();
  await page.getByLabel('Filter name').fill('Watcher view');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Watcher view', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Clear · Watcher: ${watcher.name}` }).click();
  await expect(page.getByTestId(`issue-card-${other.id}`)).toBeVisible();
  await page.getByRole('button', { name: 'Watcher view', exact: true }).click();
  await expect(page.getByTestId(`issue-card-${target.id}`)).toBeVisible();
  await expect(page.getByTestId(`issue-card-${other.id}`)).toHaveCount(0);
});

test('collapsed columns persist by project, expand without losing the drop lane, and orphan statuses stay visible but disabled', async ({ page, request }) => {
  const { boot, project, board, setBoard } = await installBoard(page, request, []);
  const todo = boot.statuses.find(status => status.key === 'todo')!;
  const qa = boot.statuses.find(status => status.key === 'qa')!;
  const removed: Issue = {
    ...board.issues[0]!, id: idBase + 3, projectId: project.id, subject: 'Retained orphan issue', statusId: 999_991,
    statusName: 'Removed status', watcherIds: [], labels: [], createdOn: '2026-10-01', updatedOn: '2026-10-01',
  };
  const ordinary: Issue = { ...removed, id: idBase + 4, subject: 'Ordinary todo issue', statusId: todo.id };
  const movable: Issue = { ...ordinary, id: idBase + 10, subject: 'Drop onto collapsed lane', statusId: qa.id, statusName: qa.name, allowedStatusIds: [todo.id] };
  setBoard({ issues: [ordinary, removed, movable], total: 3 });

  await openProjectBoard(page, project.id);
  const todoLane = page.getByTestId(`lane-status:${todo.id}`);
  const todoToggle = todoLane.getByTestId(`lane-collapse-status:${todo.id}`);
  await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
  await todoToggle.click();
  await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(todoLane).toHaveClass(/lane-collapsed/);
  await expect(todoLane.getByTestId(`issue-card-${ordinary.id}`)).toHaveCount(0);
  await expect(todoLane.locator('.lane-dropzone')).toBeVisible();

  const movedIssue: Issue = { ...movable, statusId: todo.id, statusName: todo.name, updatedOn: '2026-10-02' };
  await page.route(url => url.pathname === '/api/commands', async route => {
    const command = route.request().postDataJSON() as { type?: string; issueId?: number; input?: { statusId?: number } };
    expect(command).toMatchObject({ type: 'moveIssue', issueId: movable.id, input: { statusId: todo.id } });
    setBoard({ issues: [ordinary, removed, movedIssue], total: 3 });
    const result: CommandResult = { operation: { id: 'round5-collapse-drop', type: 'moveIssue', issueId: movable.id, status: 'done', steps: [], createdOn: '2026-10-02' }, issue: movedIssue };
    await route.fulfill({ json: result });
  });
  const sourceBox = await page.getByTestId(`issue-card-${movable.id}`).locator('.card-hit-area').boundingBox();
  const targetBox = await todoLane.locator('.lane-dropzone').boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(todoLane.locator('.lane-count')).toHaveText('2');
  await expect(todoLane).toHaveClass(/lane-collapsed/);
  await expect.poll(async () => {
    const response = await request.get('/api/bootstrap');
    const current = await response.json() as Bootstrap;
    return current.settings.collapsedBoardColumns[String(project.id)] || [];
  }).toContain(`status:${todo.id}`);
  const updatedSettings = (await (await request.get('/api/bootstrap')).json() as Bootstrap).settings.collapsedBoardColumns;
  expect(Object.keys(updatedSettings)).toEqual([String(project.id)]);
  await page.reload();
  const restoredLane = page.getByTestId(`lane-status:${todo.id}`);
  await expect(restoredLane).toHaveClass(/lane-collapsed/);
  const otherProject = boot.projects.find(candidate => candidate.id !== project.id)!;
  await openProjectBoard(page, otherProject.id);
  await expect(page.getByTestId(`lane-status:${todo.id}`)).not.toHaveClass(/lane-collapsed/);
  await openProjectBoard(page, project.id);
  await expect(page.getByTestId(`lane-status:${todo.id}`)).toHaveClass(/lane-collapsed/);
  await restoredLane.getByTestId(`lane-collapse-status:${todo.id}`).click();
  await expect(restoredLane).not.toHaveClass(/lane-collapsed/);
  await expect(restoredLane.getByTestId(`issue-card-${ordinary.id}`)).toBeVisible();

  let releaseFailure!: () => void;
  const waitBeforeFailure = new Promise<void>(resolve => { releaseFailure = resolve; });
  await page.route(url => url.pathname === '/api/settings' && url.search === '' && url.protocol === new URL(page.url()).protocol,
    async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await waitBeforeFailure;
      await route.fulfill({ status: 500, json: { code: 'errorGeneric', message: 'fixture rejection' } });
    });
  const failedSettingsWrite = page.waitForRequest(event => event.method() === 'PATCH' && new URL(event.url()).pathname === '/api/settings');
  await restoredLane.getByTestId(`lane-collapse-status:${todo.id}`).click();
  await failedSettingsWrite;
  await expect(restoredLane).toHaveClass(/lane-collapsed/);
  releaseFailure();
  await expect(restoredLane).not.toHaveClass(/lane-collapsed/);
  await expect.poll(async () => {
    const current = await (await request.get('/api/bootstrap')).json() as Bootstrap;
    return current.settings.collapsedBoardColumns[String(project.id)] || [];
  }).not.toContain(`status:${todo.id}`);

  const unknownLane = page.getByTestId('lane-status:unknown');
  await expect(unknownLane).toHaveAttribute('aria-label', 'Unavailable status');
  await expect(unknownLane.getByTestId(`issue-card-${removed.id}`)).toBeVisible();
  await expect(unknownLane.locator('.lane-dropzone')).toHaveAttribute('aria-disabled', 'true');
  await expect(unknownLane.locator('.lane-create')).toBeDisabled();
  await expect(page.getByTestId('lane-status:999991')).toHaveCount(0);
});

test('group assignees remain distinct from user ID collisions and urgent pills have readable filled colors', async ({ page, request }) => {
  const { boot, project, board, setBoard } = await installBoard(page, request, [], priorities => {
    const urgent = priorities.find(priority => priority.rank === 4)!;
    const immediate = { ...urgent, id: Math.max(...priorities.map(priority => priority.id)) + 1, name: 'Immediate', rank: 4 };
    return [...priorities, immediate];
  });
  const todo = boot.statuses.find(status => status.key === 'todo')!;
  const collidedId = boot.me.id;
  const collidingUser = board.members.find(person => person.id === collidedId)!;
  expect(collidingUser, 'the current user should be represented in the board member list').toBeTruthy();
  const groupIssue: Issue = {
    ...board.issues[0]!, id: idBase + 5, projectId: project.id, subject: 'Assigned to group', statusId: todo.id,
    assignedToId: collidedId, assignedToType: 'group', assignedToName: 'Release managers', watcherIds: [], labels: [],
    createdOn: '2026-10-01', updatedOn: '2026-10-01',
  };
  const urgent = boot.priorities.find(priority => priority.rank === 4)!;
  const immediate = boot.priorities.find(priority => priority.name === 'Immediate')!;
  const normal = boot.priorities.find(priority => priority.rank === 2)!;
  const urgentIssue: Issue = { ...groupIssue, id: idBase + 6, subject: 'Urgent card', assignedToType: 'user', priorityId: urgent.id };
  const immediateIssue: Issue = { ...groupIssue, id: idBase + 7, subject: 'Immediate card', assignedToType: 'user', priorityId: immediate.id };
  const normalIssue: Issue = { ...groupIssue, id: idBase + 8, subject: 'Normal card', assignedToType: 'user', priorityId: normal.id };
  const sameNumberUserIssue: Issue = { ...groupIssue, id: idBase + 9, subject: 'Same-number user assignment', assignedToType: 'user', assignedToName: collidingUser.name };
  const options = [
    ...board.members.map(person => ({ type: 'user' as const, id: person.id, name: person.name, avatar: person.avatar })),
    { type: 'group' as const, id: collidedId, name: 'Release managers', memberIds: [collidedId] },
  ];
  setBoard({ issues: [groupIssue, urgentIssue, immediateIssue, normalIssue, sameNumberUserIssue], assigneeOptions: options, total: 5 });
  await openProjectBoard(page, project.id);

  const groupCard = page.getByTestId(`issue-card-${groupIssue.id}`);
  await expect(groupCard.getByRole('img', { name: 'Group: Release managers', exact: true })).toBeVisible();
  await expect(groupCard.locator('.person-stack')).toHaveCount(0);
  await expect(page.getByTestId(`issue-card-${sameNumberUserIssue.id}`).locator('.person-stack')).toBeVisible();
  const urgentPill = page.getByTestId(`issue-card-${urgentIssue.id}`).locator('.priority-mark');
  const immediatePill = page.getByTestId(`issue-card-${immediateIssue.id}`).locator('.priority-mark');
  const normalPill = page.getByTestId(`issue-card-${normalIssue.id}`).locator('.priority-mark');
  await expect(urgentPill).toHaveCSS('background-color', 'rgb(165, 36, 61)');
  await expect(immediatePill).toHaveCSS('background-color', 'rgb(165, 36, 61)');
  await expect(normalPill).toHaveCSS('background-color', 'rgb(230, 238, 251)');
  for (const theme of ['light', 'dark']) for (const palette of ['blue', 'violet', 'green', 'amber']) {
    const ratios = await page.evaluate(({ theme, palette }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.palette = palette;
      const contrast = (element: Element) => {
        const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        const [foreground, background] = [getComputedStyle(element).color, getComputedStyle(element).backgroundColor].map(rgb);
        const luminance = (values: number[]) => values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
        const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (high! + 0.05) / (low! + 0.05);
      };
      return [contrast(document.querySelector('.priority-4')!), contrast(document.querySelector('.priority-2')!)];
    }, { theme, palette });
    expect(ratios[0]).toBeGreaterThan(4.5);
    expect(ratios[1]).toBeGreaterThan(4.5);
  }
  await page.getByTestId('board').getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(groupCard).toHaveCount(0);
  await expect(page.getByTestId(`issue-card-${sameNumberUserIssue.id}`)).toBeVisible();
});

test('board subscription can include new issue creation events', async ({ page, request }) => {
  const boot = await loadBootstrap(request);
  const project = boot.projects[0]!;
  await openProjectBoard(page, project.id);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const subscriptionCard = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Board subscription', exact: true }) });
  await expect(subscriptionCard).toHaveCount(1);
  const enabled = subscriptionCard.locator('.switch-row input[type="checkbox"]');
  if (!(await enabled.isChecked())) await enabled.check();
  await expect(enabled).toBeChecked();
  const newIssues = subscriptionCard.getByRole('checkbox', { name: 'New issues', exact: true });
  await expect(newIssues).toBeEnabled();
  await newIssues.check();
  await expect.poll(async () => {
    const current = await (await request.get('/api/bootstrap')).json() as Bootstrap;
    return current.settings.subscriptions[String(project.id)]?.events || [];
  }).toContain('issue_created');
});
