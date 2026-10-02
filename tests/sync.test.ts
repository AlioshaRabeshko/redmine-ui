import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../src/server/db/connection.js';
import { WorkspaceStore } from '../src/server/db/store.js';
import { createConfig } from '../src/server/config.js';
import { SyncService } from '../src/server/sync/service.js';
import type { RedmineAdapter, RedmineSnapshot } from '../src/server/redmine/adapter.js';
import { demoIssues, demoMe, demoPeople, demoPriorities, demoProjects, demoStatuses, demoVersions } from '../src/server/demo/fixtures.js';
import type { Journal } from '../src/shared/types.js';

describe('background notification ingestion', () => {
  let close: () => void;
  let store: WorkspaceStore;
  let service: SyncService;
  let snapshot: RedmineSnapshot;
  let snapshotCall: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const database = openDatabase(':memory:'); close = database.close;
    migrate(database.db, { migrationsFolder: 'drizzle' });
    const config = createConfig({ APP_MODE: 'redmine', REDMINE_API_TOKEN: 'mock', REDMINE_URL: 'https://example.invalid' });
    store = new WorkspaceStore(database.db, config.scope);
    snapshot = structuredClone({ me: demoMe, projects: demoProjects, statuses: demoStatuses, priorities: demoPriorities,
      versions: demoVersions, issues: demoIssues, people: demoPeople, projectMembers: { '10': [1, 2, 3, 4, 5], '20': [1, 3, 4, 5] }, journals: [], warnings: [] });
    snapshotCall = vi.fn(async () => structuredClone(snapshot));
    const adapter = { currentUser: vi.fn(async () => demoMe), snapshot: snapshotCall } as unknown as RedmineAdapter;
    service = new SyncService(config, store, adapter);
  });
  afterEach(() => close());
  const journal = (id: number, actorId: number, notes = 'comment'): Journal => ({ id, user: demoPeople.find(person => person.id === actorId)!, notes, createdOn: new Date().toISOString(), changes: [] });

  it('starts with a quiet baseline then persists/deduplicates new foreign comments', async () => {
    snapshot.journals = [{ issueId: 1001, journal: journal(70, 2, 'historical') }];
    await service.sync();
    expect(await store.getNotifications()).toEqual([]);
    snapshot.journals.push({ issueId: 1001, journal: journal(71, 3, 'new comment') });
    await service.sync();
    expect(await store.getNotifications()).toHaveLength(1);
    expect((await store.getNotifications())[0]).toMatchObject({ id: 'journal:71', issueId: 1001, journalId: 71, actor: { id: 3 } });
    await store.markNotificationsRead(['journal:71']);
    await service.sync();
    expect(await store.getNotifications()).toEqual([]);
    expect(await store.getNotifications(true)).toHaveLength(1);
  });

  it('hides own events but always follows assigned tasks and assignment away', async () => {
    await service.sync();
    const settings = await store.getSettings();
    settings.subscriptions = { '10': { enabled: false, events: [] }, '20': { enabled: false, events: [] } };
    await store.setSettings(settings);
    snapshot.issues[0].assignedToId = demoMe.id;
    snapshot.journals = [
      { issueId: 1001, journal: journal(72, 1, 'my own') },
      { issueId: 1001, journal: journal(73, 2, 'assigned task comment') },
      { issueId: 1004, journal: { ...journal(74, 3, ''), changes: [{ field: 'assigned_to_id', oldValue: '1', newValue: '2' }] } },
      { issueId: 1005, journal: journal(75, 2, 'unsubscribed') },
    ];
    await service.sync();
    expect((await store.getNotifications()).map(item => item.id).sort()).toEqual(['journal:73', 'journal:74']);
  });

  it('uses a single in-flight poll and respects subscription events within mixed journals', async () => {
    await service.sync();
    const settings = await store.getSettings();
    settings.subscriptions['10'] = { enabled: true, events: ['status'] };
    await store.setSettings(settings);
    snapshot.journals = [{ issueId: 1001, journal: { ...journal(76, 3), changes: [{ field: 'status_id', oldValue: '3', newValue: '4' }] } }];
    const before = snapshotCall.mock.calls.length;
    await Promise.all([service.sync(), service.sync(), service.sync()]);
    expect(snapshotCall.mock.calls.length - before).toBe(1);
    expect(await store.getNotifications()).toHaveLength(1);
  });

  it('records blocked real automation without modifying the issue', async () => {
    await service.sync();
    snapshot.issues[0].labels = ['Build: Failed'];
    snapshot.issues[0].updatedOn = new Date().toISOString();
    await service.sync();
    expect((await store.getIssue(1001))?.statusId).toBe(4);
    expect((await store.getOperations()).filter(op => op.type === 'runAutomation')).toMatchObject([{ status: 'blocked', issueId: 1001 }]);
    await service.sync();
    expect((await store.getOperations()).filter(op => op.type === 'runAutomation')).toHaveLength(1);
  });

  it('does not rerun historical CI transitions from the initial quiet baseline', async () => {
    snapshot.journals = [{ issueId: 1008, journal: { ...journal(80, 2, ''), changes: [{ field: 'Labels', oldValue: 'Build: Running', newValue: 'Build: Failed' }] } }];
    await service.sync();
    snapshot.journals.push({ issueId: 1008, journal: journal(81, 3, 'New comment after old CI failure') });
    await service.sync();
    expect((await store.getOperations()).filter(op => op.type === 'runAutomation')).toEqual([]);
  });
});
