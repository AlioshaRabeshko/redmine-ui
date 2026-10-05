import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../shared/types.js';
import { createConfig } from './config.js';
import { defaultSettings, parseSettings } from './settings.js';

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
});
