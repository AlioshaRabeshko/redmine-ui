import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Notification } from '../shared/types.js';
import { createConfig } from './config.js';
import { createApp, type WorkspaceApp } from './app.js';
import { defaultSettings, parseSettings } from './settings.js';

let app: WorkspaceApp | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (app) { app.backend.stop(); await app.close(); app = undefined; }
});

describe('notification and polling settings compatibility', () => {
  it('defaults new settings and server fallback polling to ten seconds while keeping explicit intervals', () => {
    expect(defaultSettings.pollIntervalSeconds).toBe(10);
    expect(createConfig({ APP_MODE: 'demo' }).pollIntervalSeconds).toBe(10);
    expect(createConfig({ APP_MODE: 'demo', POLL_INTERVAL_SECONDS: 45 }).pollIntervalSeconds).toBe(45);
    expect(createConfig({ APP_MODE: 'demo', POLL_INTERVAL_SECONDS: 3 }).pollIntervalSeconds).toBe(10);
    expect(parseSettings({ ...structuredClone(defaultSettings), pollIntervalSeconds: 30 }).pollIntervalSeconds).toBe(30);
  });

  it('retains hasNotifications in saved view filters', () => {
    const value: AppSettings = {
      ...structuredClone(defaultSettings),
      savedViews: [{ id: 'unread', projectId: 10, name: 'Unread', view: 'all', filters: { search: 'bug', hasNotifications: true } }],
    };
    expect(parseSettings(value).savedViews[0]?.filters).toEqual({ search: 'bug', hasNotifications: true });
  });

  it('sanitizes legacy subscription events before settings reads and subsequent patches', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    const stored = structuredClone(defaultSettings) as AppSettings;
    stored.locale = 'pl';
    (stored.subscriptions as unknown as Record<string, { enabled: boolean; events: string[] }>)['10'] = {
      enabled: true, events: ['comment', 'legacy_future_event', 'comment'],
    };
    await app.backend.store.setValue('settings', stored);
    await app.backend.store.setValue('settingsSchemaVersion', 3);

    const read = await app.backend.store.getSettings();
    expect(read.locale).toBe('pl');
    expect(read.subscriptions['10']).toEqual({ enabled: true, events: ['comment'] });
    expect(await app.backend.store.getValue('settingsSchemaVersion')).toBe(4);
    expect(await app.backend.store.getValue('settings')).toMatchObject({ subscriptions: { '10': { enabled: true, events: ['comment'] } } });

    await app.backend.commands.patchSettings({ subscriptions: { '10': { enabled: false, events: ['status'] } } });
    expect((await app.backend.store.getSettings()).subscriptions['10']).toEqual({ enabled: false, events: ['status'] });
  });

  it('records issue-created opt-in transitions on the server and resets the cutoff after re-enabling', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    const firstOptIn = new Date('2026-10-14T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(firstOptIn);

    await app.backend.commands.patchSettings({ subscriptions: { '10': { enabled: true, events: ['issue_created'] } } });
    const key = 'issue-created-subscription:10';
    expect(await app.backend.store.getCursor(key)).toBe(firstOptIn.toISOString());

    const historical: Notification = { id: 'issue-created:900', projectId: 10, issueId: 900,
      actor: { id: 2, name: 'Alex' }, kind: 'issue_created', text: 'Existing issue', createdOn: firstOptIn.toISOString(), eventKinds: [] };
    await app.backend.store.saveNotification(historical);
    await app.backend.store.markNotificationsRead([historical.id]);
    await app.backend.store.markSourceEventSeen(historical.id);

    vi.setSystemTime(new Date('2026-10-14T10:01:00.000Z'));
    await app.backend.commands.patchSettings({ subscriptions: { '10': { enabled: true, events: ['comment', 'issue_created'] } } });
    expect(await app.backend.store.getCursor(key)).toBe(firstOptIn.toISOString());

    await app.backend.commands.patchSettings({ subscriptions: { '10': { enabled: false, events: ['comment', 'issue_created'] } } });
    vi.setSystemTime(new Date('2026-10-14T10:02:00.000Z'));
    await app.backend.commands.patchSettings({ subscriptions: { '10': { enabled: true, events: ['issue_created'] } } });
    expect(await app.backend.store.getCursor(key)).toBe('2026-10-14T10:02:00.000Z');
    expect(await app.backend.store.getSettings()).not.toHaveProperty('issueCreatedCutoffs');
    expect(await app.backend.store.hasSeenSourceEvent(historical.id)).toBe(true);
    expect(await app.backend.store.getNotifications(true)).toMatchObject([{ id: historical.id, readAt: expect.any(String) }]);

    await expect(app.backend.commands.patchSettings({
      subscriptions: { '10': { enabled: true, events: ['issue_created'] } }, issueCreatedCutoffs: { '10': '2000-01-01T00:00:00.000Z' },
    })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
  });
});
