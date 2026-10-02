import { expect, test, type Page } from '@playwright/test';
import type { Bootstrap } from '../src/shared/types.js';

async function imageFile(page: Page, color = '#5471aa') {
  const dataUrl = await page.evaluate(color => {
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 60;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color; context.fillRect(0, 0, 80, 60);
    context.fillStyle = '#152342'; context.fillRect(0, 30, 80, 30);
    return canvas.toDataURL('image/png');
  }, color);
  return { name: 'project-background.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64') };
}

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { locale: 'uk', theme: 'light', palette: 'blue' } });
});

test('board has one compact toolbar with no duplicate title or mode banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('.mode-banner')).toHaveCount(0);
  await expect(page.locator('.board-title-row')).toHaveCount(0);
  await expect(page.locator('.connection-pill')).toBeVisible();
  const views = await page.locator('.board-view-button').first().boundingBox();
  const create = await page.getByTestId('new-issue').boundingBox();
  expect(Math.abs((views!.y + views!.height / 2) - (create!.y + create!.height / 2))).toBeLessThan(10);
  expect((await page.locator('.board-lanes').boundingBox())!.y).toBeLessThan(180);
  await page.screenshot({ path: '/tmp/redmine-ui-compact-board.png' });
});

test('project background uploads locally, survives reload, stays project-scoped and can be removed', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = boot.projects[0].id;
  const otherId = boot.projects[1].id;
  try {
    await page.goto(`/?project=${projectId}&tab=settings`);
    const image = await imageFile(page);
    await page.getByTestId('project-background-upload').setInputFiles(image);
    await expect(page.locator('.project-background-preview')).toBeVisible();
    await expect.poll(() => page.locator('.project-background-preview').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: '/tmp/redmine-ui-background-settings.png' });
    await expect.poll(async () => {
      const settings = await (await request.get('/api/settings')).json();
      return settings.projectBackgrounds[String(projectId)];
    }).toMatch(new RegExp(`^/api/projects/${projectId}/background\\?v=`));
    const settings = await (await request.get('/api/settings')).json();
    const imageResponse = await request.get(settings.projectBackgrounds[String(projectId)]);
    expect(imageResponse.ok()).toBe(true);
    expect(imageResponse.headers()['content-type']).toContain('image/png');
    expect(await imageResponse.body()).toEqual(image.buffer);
    await page.locator('.nav-item').filter({ hasText: /^Усі$/ }).click();
    await expect(page.getByTestId('board')).toHaveClass(/has-project-background/);
    expect(await page.getByTestId('board').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(`/api/projects/${projectId}/background`);
    await page.reload();
    await expect(page.getByTestId('board')).toHaveClass(/has-project-background/);
    await page.screenshot({ path: '/tmp/redmine-ui-project-background.png' });
    await page.goto(`/?project=${otherId}`);
    await expect(page.getByTestId('board')).not.toHaveClass(/has-project-background/);
    await page.goto(`/?project=${projectId}&tab=settings`);
    await page.locator('.project-background-card').getByRole('button', { name: 'Видалити зображення', exact: true }).click();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectBackgrounds[String(projectId)]).toBeUndefined();
    await page.locator('.nav-item').filter({ hasText: /^Усі$/ }).click();
    await expect(page.getByTestId('board')).not.toHaveClass(/has-project-background/);
    await page.reload();
    await expect(page.getByTestId('board')).not.toHaveClass(/has-project-background/);
  } finally {
    await request.patch('/api/settings', { data: { projectBackgrounds: { [projectId]: null, [otherId]: null } } });
  }
});

test('invalid files and a failed settings patch keep the current background', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = boot.projects[0].id;
  try {
    await page.goto(`/?project=${projectId}&tab=settings`);
    const image = await imageFile(page);
    await page.getByTestId('project-background-upload').setInputFiles(image);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectBackgrounds[String(projectId)]).toBeTruthy();
    const original = (await (await request.get('/api/settings')).json()).projectBackgrounds[String(projectId)];
    await page.getByTestId('project-background-upload').setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(page.locator('.project-background-card .notice-error')).toBeVisible();
    expect((await (await request.get('/api/settings')).json()).projectBackgrounds[String(projectId)]).toBe(original);
    await page.route('**/api/settings', async route => {
      if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, json: { code: 'OFFLINE', message: 'Mock failure' } });
      else await route.continue();
    });
    const uploaded = page.waitForResponse(response => response.url().includes('/background') && response.request().method() === 'PUT');
    const failedPatch = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH' && response.status() === 503);
    await page.getByTestId('project-background-upload').setInputFiles(await imageFile(page, '#b07141'));
    await Promise.all([uploaded, failedPatch]);
    await expect(page.locator('.project-background-card .notice-error')).toBeVisible();
    await expect(page.locator('.project-background-preview')).toHaveAttribute('src', original);
    expect(await (await request.get(original)).body()).toEqual(image.buffer);
  } finally {
    await request.patch('/api/settings', { data: { projectBackgrounds: { [projectId]: null } } });
  }
});

test('local background settings remain available when Redmine actions are read-only', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const projectId = boot.projects[0].id;
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const current = await response.json() as Bootstrap;
    await route.fulfill({ json: { ...current, mode: 'redmine', readOnly: true, capabilities: { ...current.capabilities, canWrite: false } } });
  });
  let commands = 0;
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.method() === 'POST') commands++; });
  try {
    await page.goto(`/?project=${projectId}&tab=settings`);
    await page.getByTestId('project-background-upload').setInputFiles(await imageFile(page));
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).projectBackgrounds[String(projectId)]).toBeTruthy();
    await page.locator('.nav-item').filter({ hasText: /^Усі$/ }).click();
    await expect(page.getByTestId('board')).toHaveClass(/has-project-background/);
    await expect(page.getByTestId('new-issue')).toBeDisabled();
    expect(commands).toBe(0);
  } finally {
    await request.patch('/api/settings', { data: { projectBackgrounds: { [projectId]: null } } });
  }
});
