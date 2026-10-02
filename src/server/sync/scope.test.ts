import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../db/connection.js';
import { WorkspaceStore } from '../db/store.js';
import { defaultSettings } from '../settings.js';

describe('Redmine user scope adoption', () => {
  let opened: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    opened = openDatabase(':memory:');
    migrate(opened.db, { migrationsFolder: 'drizzle' });
  });
  afterEach(() => opened.close());

  it('preserves local settings on first user discovery without copying them between users', async () => {
    const initialScope = 'redmine:https://redmine.example.invalid';
    const store = new WorkspaceStore(opened.db, initialScope);
    await store.setSettings({ ...structuredClone(defaultSettings), locale: 'es' });

    store.adoptInitialSettingsIntoUserScope(`${initialScope}:user:7`, initialScope);
    expect((await store.getSettings()).locale).toBe('es');

    store.adoptInitialSettingsIntoUserScope(`${initialScope}:user:8`, initialScope);
    expect((await store.getSettings()).locale).toBe('uk');
  });
});
