import { expect, type Locator, type Page } from '@playwright/test';

/** Switch a RichEditor instance to its source textarea for tests of exact persisted markup. */
export async function sourceEditor(page: Page, testId: string): Promise<Locator> {
  if (testId === 'comment-composer') {
    const activate = page.getByTestId('comment-composer-activate');
    await expect(page.locator('[data-testid="comment-composer"], [data-testid="comment-composer-activate"]')).toBeVisible();
    if (await activate.isVisible()) await activate.click();
  }
  const root = page.getByTestId(testId);
  const source = root.getByTestId(`${testId}-source`);
  await expect(root).toBeVisible();
  if (!(await source.isVisible())) {
    const toggle = root.getByTestId(`${testId}-source-toggle`);
    await expect(toggle).toBeVisible();
    await toggle.click();
  }
  await expect(source).toBeVisible();
  return source;
}

/** The issue description opens in preview by default; enter its editable source view. */
export async function editDescriptionSource(page: Page): Promise<Locator> {
  const dialog = page.getByTestId('issue-dialog');
  // Opening an issue is asynchronous. Wait for the description controls, then
  // select Edit even if the one-shot preview visibility check would race the load.
  const editToggle = dialog.getByTestId('issue-description-edit-toggle');
  await expect(editToggle).toBeVisible();
  await editToggle.click();
  return sourceEditor(page, 'issue-description-editor');
}
