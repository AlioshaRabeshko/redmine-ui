import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Issue, Journal, Project } from '../../shared/types.js';
import { openDatabase } from '../db/connection.js';
import { WorkspaceStore } from '../db/store.js';
import { defaultSettings } from '../settings.js';
import { createConfig } from '../config.js';
import type { RedmineAdapter, RedmineSnapshot } from '../redmine/adapter.js';
import { SyncService } from './service.js';

describe('sync notification categories', () => {
  let opened: ReturnType<typeof openDatabase> | undefined;
  afterEach(() => { opened?.close(); opened = undefined; });

  it('keeps assigned issues eligible but stores only events covered by the project mask', async () => {
    opened = openDatabase(':memory:');
    migrate(opened.db, { migrationsFolder: 'drizzle' });
    const config = createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.test' });
    const store = new WorkspaceStore(opened.db, `${config.scope}:user:1`);
    const settings = structuredClone(defaultSettings);
    settings.automationEnabled = false;
    settings.subscriptions['10'] = { enabled: false, events: ['comment'] };
    await store.setSettings(settings);
    await store.setCursor('baseline', '2026-10-04T00:00:00.000Z');
    await store.setCursor('first-baseline', '2026-10-04T00:00:00.000Z');

    const me = { id: 1, name: 'Me' };
    const other = { id: 2, name: 'Other' };
    const project: Project = { id: 10, name: 'Project', identifier: 'project' };
    const issue = (id: number, assignedToId?: number): Issue => ({
      id, projectId: 10, subject: `Issue ${id}`, description: '', statusId: 1, priorityId: 1, trackerId: 1,
      trackerName: 'Bug', authorId: 2, assignedToId, branch: '', labels: [], watcherIds: [],
      createdOn: '2026-10-04T00:00:00.000Z', updatedOn: '2026-10-05T10:00:00.000Z', attachments: [],
    });
    const assigned = issue(100, me.id);
    const unassignedToMe = issue(101, other.id);
    const journal = (id: number, user: typeof other, notes: string, changes: Journal['changes']): Journal => ({
      id, user, notes, changes, createdOn: `2026-10-05T10:0${id - 200}:00.000Z`,
    });
    const snapshot: RedmineSnapshot = {
      me, projects: [project], statuses: [{ id: 1, name: 'To Do', key: 'todo', isClosed: false }],
      priorities: [{ id: 1, name: 'Normal', rank: 1 }], versions: [], issues: [assigned, unassignedToMe],
      people: [me, other], projectMembers: { '10': [1, 2] }, projectMembershipIds: { '10': [1, 2] },
      journals: [
        { issueId: assigned.id, journal: journal(201, other, 'A comment', [{ field: 'Labels', oldValue: 'Build: Running', newValue: 'Build: Failed' }]) },
        { issueId: assigned.id, journal: journal(202, other, '', [{ field: 'status_id', oldValue: '1', newValue: '1' }]) },
        { issueId: unassignedToMe.id, journal: journal(203, other, '', [{ field: 'status_id', oldValue: '1', newValue: '1' }]) },
      ],
      labelOptions: { '10': [{ id: '606', name: 'Build: Failed', fieldId: 4 }] }, warnings: [],
    };
    const adapter = {
      currentUser: async () => me,
      snapshot: async () => snapshot,
    } as unknown as RedmineAdapter;
    const sync = new SyncService(config, store, adapter);

    const result = await sync.sync();
    expect(result.notificationsAdded).toBe(1);
    const stored = await store.getNotifications(false);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'journal:201', issueId: assigned.id, notes: 'A comment', eventKinds: ['comment', 'labels'] });
    expect(stored[0]?.changes).toEqual([{ field: 'Labels', oldValue: 'Build: Running', newValue: 'Build: Failed' }]);
    expect(await store.hasSeenSourceEvent('journal:202')).toBe(true);
    expect(await store.hasSeenSourceEvent('journal:203')).toBe(true);
    expect((await store.getNotifications(false)).map((item) => item.id)).toEqual(['journal:201']);
  });
});
