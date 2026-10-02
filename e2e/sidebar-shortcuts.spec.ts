import { expect, test } from '@playwright/test';
import { defaultSettings } from '../src/server/settings.js';

const sidebarKey = 'redmine-workspace:sidebar-collapsed';

test.beforeEach(async ({ request }) => {
  const boot = await (await request.get('/api/bootstrap')).json();
  expect(boot.mode).toBe('demo');
  await request.patch('/api/settings', { data: { locale: 'uk', shortcuts: defaultSettings.shortcuts } });
});

test.afterEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { shortcuts: defaultSettings.shortcuts } });
});

test('sidebar persists both states after keyboard and button toggles without changing history', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByTestId('sidebar-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const originalUrl = page.url();
  await page.keyboard.press('Meta+b');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), sidebarKey)).toBe('true');
  expect(page.url()).toBe(originalUrl);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, repeat: true, cancelable: true })));
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Control+b');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('b');
  await expect(page.getByTestId('project-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-picker')).not.toBeVisible();
});

test('section shortcuts respect text input and browser history without mutating issues or notifications', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(commands|notifications)/.test(request.url())) writes.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Пошук', exact: true });
  await search.focus();
  await page.keyboard.press('Shift+I');
  await page.keyboard.press('Shift+P');
  await expect(search).toHaveValue('IP');
  await expect(page.getByTestId('board')).toBeVisible();
  await search.fill('');
  await search.blur();
  await page.keyboard.press('Shift+I');
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('inbox');
  await page.keyboard.press('Shift+P');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('settings');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('inbox');
  await page.goForward();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  expect(writes).toEqual([]);
});

test('new actions can be rebound and disabled with explicit shortcut save', async ({ page, request }) => {
  await page.goto('/?tab=settings');
  const row = (action: string) => page.locator(`[data-shortcut-action="${action}"]`);
  await row('toggleSidebar').locator('.shortcut-input').fill('Alt+B');
  await row('openInbox').locator('.shortcut-input').fill('Alt+I');
  await row('openSettings').locator('.shortcut-input').fill('Alt+P');
  expect((await (await request.get('/api/settings')).json()).shortcuts.find((item: { action: string }) => item.action === 'toggleSidebar').keys).toBe('Mod+B');
  await row('openSettings').locator('.shortcut-input').press('Meta+s');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).shortcuts.find((item: { action: string }) => item.action === 'toggleSidebar').keys).toBe('Alt+B');
  await page.reload();
  await expect(row('toggleSidebar').locator('.shortcut-input')).toHaveValue('Alt+B');
  await page.locator('.breadcrumbs').click();
  await page.keyboard.press('Meta+b');
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Alt+b');
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Alt+i');
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('inbox');
  await page.keyboard.press('Alt+p');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await row('toggleSidebar').getByRole('checkbox').uncheck();
  await row('toggleSidebar').locator('.shortcut-input').press('Meta+s');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).shortcuts.find((item: { action: string }) => item.action === 'toggleSidebar').enabled).toBe(false);
  await page.locator('.breadcrumbs').click();
  await page.keyboard.press('Alt+b');
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
});
