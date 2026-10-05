import { expect, test } from '@playwright/test';

test('explicit real write capability activates controls without sending real mutations', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, mode: 'redmine', connected: true, readOnly: false, capabilities: { ...data.capabilities, canWrite: true } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('.write-mode-pill')).toContainText('Запис увімкнено');
  await expect(page.locator('.readonly-mode-pill')).toHaveCount(0);
  await page.getByTestId('new-issue').click();
  await page.getByTestId('issue-title').fill('Mock capability UI only');
  await expect(page.getByTestId('issue-submit')).toBeEnabled();
  // No submit: this scenario inspects controls only; server remains isolated demo.
});

test('configured real readonly continues to block submission', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, mode: 'redmine', connected: true, readOnly: true, capabilities: { ...data.capabilities, canWrite: false } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('.readonly-mode-pill')).toBeVisible();
  await expect(page.locator('.write-mode-pill')).toHaveCount(0);
  await expect(page.getByTestId('new-issue')).toBeDisabled();
  await page.goto('/?form=new-issue');
  await page.getByTestId('issue-title').fill('Blocked mock capability');
  await expect(page.getByTestId('issue-submit')).toBeDisabled();
});

test('real create retry preserves its operation ID and scoped draft across reload', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, mode: 'redmine', connected: true, readOnly: false, capabilities: { ...data.capabilities, canWrite: true } } });
  });
  const operationIds: string[] = [];
  await page.route('**/api/commands', async route => {
    const command = route.request().postDataJSON();
    operationIds.push(command.operationId);
    await route.fulfill({ json: { operation: { id: command.operationId, type: command.type, status: 'blocked', errorCode: 'OUTCOME_UNKNOWN', error: 'Mock uncertain response', steps: [], createdOn: new Date().toISOString() } } });
  });
  await page.goto('/');
  await page.getByTestId('new-issue').click();
  await page.getByTestId('issue-title').fill('Mock uncertain create identity');
  await page.getByTestId('issue-submit').click();
  await expect(page.getByTestId('issue-dialog')).toContainText('Відповідь сервера втрачено');
  await page.reload();
  await expect(page.getByTestId('issue-title')).toHaveValue('Mock uncertain create identity');
  await page.getByTestId('issue-submit').click();
  await expect(page.getByTestId('issue-dialog')).toContainText('Відповідь сервера втрачено');
  expect(operationIds).toHaveLength(2);
  expect(operationIds[1]).toBe(operationIds[0]);
});
