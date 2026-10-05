import { expect, test } from '@playwright/test';
import type { Bootstrap, Notification } from '../src/shared/types.js';

test('Inbox shows issue subject and every event newest first, while acknowledging only the selected event', async ({ page, request }) => {
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const project = boot.projects[0]!;
  await request.patch('/api/settings', { data: { locale: 'uk' } });

  const actor = { id: 98_123, name: 'Inbox Actor' };
  const older: Notification = {
    id: 'round3-comment-old', projectId: project.id, issueId: 8123, issueSubject: 'Показати кешований заголовок', journalId: 98123,
    actor, kind: 'comment', text: 'Старий коментар', notes: 'Старий коментар', changes: [], eventKinds: ['comment'], createdOn: '2026-10-04T10:00:00.000Z',
  };
  const newer: Notification = {
    id: 'round3-mixed-new', projectId: project.id, issueId: 8123, issueSubject: 'Показати кешований заголовок', journalId: 98124,
    actor, kind: 'comment', text: 'Перевіряю результат.', notes: 'Перевіряю результат.',
    changes: [{ field: 'Labels', oldValue: '606', newValue: '607' }], eventKinds: ['comment', 'labels'],
    changeLookups: { labels: [{ id: '606', name: 'Build: Running' }, { id: '607', name: 'Build: Failed' }] },
    createdOn: '2026-10-04T11:00:00.000Z',
  };
  let events = [older, newer];
  const readIds: string[][] = [];
  await page.route((url) => url.pathname === '/api/notifications', (route) => route.fulfill({ json: events }));
  await page.route((url) => url.pathname === '/api/notifications/read', async (route) => {
    const ids = route.request().postDataJSON().ids as string[];
    readIds.push(ids);
    events = events.filter((event) => !ids.includes(event.id));
    await route.fulfill({ json: { updated: ids.length, unreadCount: events.length } });
  });

  await page.goto(`/?project=${project.id}&tab=inbox`);
  const group = page.getByTestId('notification-group-8123');
  await expect(group).toBeVisible();
  await expect(group).toContainText('Показати кешований заголовок');
  await expect(group.locator('.notification-group-toggle')).toHaveCount(0);
  const rows = group.locator('.notification-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-testid', 'notification-round3-mixed-new');
  await expect(rows.first()).toContainText('Перевіряю результат.');
  await expect(rows.first()).toContainText('Build: Running');
  await expect(rows.first()).toContainText('Build: Failed');
  await expect(group.locator('.notification-group-heading')).not.toContainText('Перевіряю результат.');

  await rows.first().getByRole('button', { name: 'Прочитати', exact: true }).click();
  await expect.poll(() => readIds.length).toBe(1);
  expect(readIds[0]).toEqual(['round3-mixed-new']);
  await expect(group.locator('.notification-row')).toHaveCount(1);
  await expect(group.locator('.notification-row').first()).toHaveAttribute('data-testid', 'notification-round3-comment-old');
});
