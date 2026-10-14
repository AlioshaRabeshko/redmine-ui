import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, CommandResult } from '../src/shared/types.js';

async function createVisualFixture(request: APIRequestContext) {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  expect(boot.mode).toBe('demo');
  const todo = boot.statuses.find(status => status.key === 'todo')!;
  const response = await request.post('/api/commands', { data: {
    type: 'createIssue', projectId: boot.projects[0]!.id,
    input: {
      subject: 'Round five visual QA issue',
      description: 'Visual preview paragraph with **bold** text.\n\nA second line for the editor.',
      statusId: todo.id,
    },
  } });
  expect(response.ok()).toBe(true);
  const issue = (await response.json() as CommandResult).issue!;
  return { boot, issue, todo };
}

test('captures collapsed board and issue preview/editor at desktop widths in light and dark themes', async ({ page, request }) => {
  const { boot, issue, todo } = await createVisualFixture(request);
  for (const width of [1280, 1600]) for (const theme of ['light', 'dark'] as const) {
    // This map merges by project. Explicit null clears a collapse left by an
    // earlier test in the same isolated demo database.
    await request.patch('/api/settings', { data: {
      locale: 'en', theme, palette: 'blue',
      collapsedBoardColumns: { [String(issue.projectId)]: null },
    } });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/?project=${issue.projectId}`);
    await expect(page.getByTestId('board')).toBeVisible();

    const lane = page.getByTestId(`lane-status:${todo.id}`);
    await lane.getByTestId(`lane-collapse-status:${todo.id}`).click();
    await expect(lane).toHaveClass(/lane-collapsed/);
    await page.screenshot({ path: `/tmp/round5-${width}-${theme}-board-collapsed.png`, animations: 'disabled' });

    // The target card sits in the collapsed Todo lane. Reopen the issue by its
    // canonical URL so the screenshot retains the collapsed board behind it.
    await page.goto(`/?project=${issue.projectId}&issue=${issue.id}`);
    const dialog = page.getByTestId('issue-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('issue-description-preview')).toContainText('Visual preview paragraph');
    await page.screenshot({ path: `/tmp/round5-${width}-${theme}-dialog-preview.png`, animations: 'disabled' });

    await dialog.getByTestId('issue-description-edit-toggle').click();
    await expect(dialog.getByTestId('issue-description-editor-visual')).toBeVisible();
    await page.screenshot({ path: `/tmp/round5-${width}-${theme}-dialog-editor.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
});
