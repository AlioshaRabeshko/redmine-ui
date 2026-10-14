import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../src/server/db/connection.js';
import { WorkspaceStore } from '../src/server/db/store.js';
import { createConfig } from '../src/server/config.js';
import { SyncService } from '../src/server/sync/service.js';
import { CommandService } from '../src/server/commands/service.js';
import { issueCreatedSubscriptionCursorKey } from '../src/server/notifications.js';
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
  afterEach(() => { vi.useRealTimers(); close(); });
  const journal = (id: number, actorId: number, notes = 'comment'): Journal => ({ id, user: demoPeople.find(person => person.id === actorId)!, notes, createdOn: new Date().toISOString(), changes: [] });

  it('persists Redmine project tracker metadata through the existing project sync path', async () => {
    snapshot.projects[0] = { ...snapshot.projects[0]!, trackers: [{ id: 88, name: 'Release type' }] };
    await service.sync();
    expect((await store.getProjects()).find(project => project.id === snapshot.projects[0]!.id)?.trackers)
      .toEqual([{ id: 88, name: 'Release type' }]);
  });

  it('clears unverified journal capabilities on every successful real sync', async () => {
    await store.setValue('capabilities', { canWrite: true, journalEditing: true, journalDeleting: true, journalLikes: true,
      primaryAssigneeFieldIds: { '10': 99 } });

    await service.sync();

    expect(await store.getValue('capabilities')).toMatchObject({
      journalEditing: false, journalDeleting: false, journalLikes: false,
      primaryAssigneeFieldIds: {},
    });
  });

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

  it('does not notify old archived history discovered after baseline, but does notify new comments', async () => {
    await service.sync();
    snapshot.issues.push({ ...snapshot.issues[0], id: 9001 });
    snapshot.journals = [
      { issueId: 9001, journal: { ...journal(9901, 2, 'old archive'), createdOn: '2001-01-01T00:00:00.000Z' } },
      { issueId: 9001, journal: { ...journal(9902, 2, 'new comment'), createdOn: new Date(Date.now() + 1000).toISOString() } },
    ];
    await service.sync();
    expect((await store.getNotifications()).map(item => item.journalId)).toEqual([9902]);
    expect(await store.hasSeenSourceEvent('journal:9901')).toBe(true);
  });

  it('emits issue-created only for unseen issues created since the previous successful cursor', async () => {
    await service.sync();
    const previousSyncAt = await store.getCursor('baseline');
    const settings = await store.getSettings();
    settings.subscriptions['10'] = { enabled: true, events: ['issue_created'] };
    await store.setSettings(settings);
    await store.setCursor(issueCreatedSubscriptionCursorKey(10), previousSyncAt!);

    const createdOn = new Date(Date.now() + 1000).toISOString();
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9002, authorId: 2, createdOn });
    await service.sync();
    expect(await store.getNotifications()).toMatchObject([{ id: 'issue-created:9002', issueId: 9002, kind: 'issue_created', text: snapshot.issues.at(-1)!.subject }]);
    expect(await store.hasSeenSourceEvent('issue-created:9002')).toBe(true);
  });

  it('does not notify when an old issue is first discovered after the first baseline', async () => {
    await service.sync();
    const firstBaseline = new Date(Date.now() - 60_000).toISOString();
    const staleIssueCreatedOn = new Date(Date.parse(firstBaseline) + 10_000).toISOString();
    await store.setCursor('first-baseline', firstBaseline);
    await store.setCursor('baseline', new Date(Date.now() - 30_000).toISOString());
    await service.sync(); // this successful sync advances the cursor past staleIssueCreatedOn

    const settings = await store.getSettings();
    settings.subscriptions['10'] = { enabled: true, events: ['issue_created'] };
    await store.setSettings(settings);
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9003, authorId: 2, createdOn: staleIssueCreatedOn });
    await service.sync();

    expect(await store.hasSeenSourceEvent('issue-created:9003')).toBe(true);
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9003')).toBe(false);
  });

  it('suppresses creations from an offline gap that predate the issue-created opt-in', async () => {
    await service.sync();
    const previousSyncAt = Date.now() - 120_000;
    const activatedAt = previousSyncAt + 30_000;
    const beforeOptIn = previousSyncAt + 10_000;
    const afterOptIn = previousSyncAt + 40_000;
    await store.setCursor('baseline', new Date(previousSyncAt).toISOString());
    await store.setCursor(issueCreatedSubscriptionCursorKey(10), new Date(activatedAt).toISOString());
    const settings = await store.getSettings();
    settings.subscriptions['10'] = { enabled: true, events: ['issue_created'] };
    await store.setSettings(settings);
    snapshot.issues.push(
      { ...snapshot.issues[0]!, id: 9010, authorId: 2, createdOn: new Date(beforeOptIn).toISOString() },
      { ...snapshot.issues[0]!, id: 9011, authorId: 2, createdOn: new Date(afterOptIn).toISOString() },
    );

    await service.sync();

    expect(await store.hasSeenSourceEvent('issue-created:9010')).toBe(true);
    expect(await store.hasSeenSourceEvent('issue-created:9011')).toBe(true);
    expect((await store.getNotifications()).map(item => item.id)).toContain('issue-created:9011');
    expect((await store.getNotifications()).map(item => item.id)).not.toContain('issue-created:9010');
  });

  it('quietly initializes a missing cutoff for legacy active issue-created subscriptions', async () => {
    await service.sync();
    const settings = await store.getSettings();
    settings.subscriptions['10'] = { enabled: true, events: ['issue_created'] };
    await store.setSettings(settings);
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9012, authorId: 2, createdOn: new Date(Date.now() + 1000).toISOString() });

    await service.sync();

    expect(await store.getCursor(issueCreatedSubscriptionCursorKey(10))).toBeTruthy();
    expect(await store.hasSeenSourceEvent('issue-created:9012')).toBe(true);
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9012')).toBe(false);
  });

  it('uses only the project list from the last successful sync after interrupted re-access', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-14T10:00:00.000Z');
    vi.setSystemTime(start);
    await service.sync();

    const reappearingProject = { ...snapshot.projects[0]!, id: 30, name: 'Reappearing', identifier: 'reappearing' };
    const settings = await store.getSettings();
    settings.subscriptions['30'] = { enabled: true, events: ['issue_created'] };
    await store.setSettings(settings);
    await store.setCursor(issueCreatedSubscriptionCursorKey(30), start.toISOString());
    snapshot.projects.push(reappearingProject);
    snapshot.projectMembers['30'] = [2];
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9200, projectId: 30, authorId: 2,
      createdOn: new Date(start.getTime() + 10_000).toISOString() });
    vi.setSystemTime(new Date(start.getTime() + 60_000));
    await service.sync(); // Project 30 is now in the successful scope.

    snapshot.projects = snapshot.projects.filter(project => project.id !== 30);
    snapshot.issues = snapshot.issues.filter(issue => issue.projectId !== 30);
    vi.setSystemTime(new Date(start.getTime() + 120_000));
    await service.sync(); // Project 30 is absent from the last successful scope.
    expect(await store.getValue<number[]>('successfulProjectIds')).not.toContain(30);

    const historicalCreatedOn = new Date(start.getTime() + 150_000).toISOString();
    snapshot.projects.push(reappearingProject);
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9201, projectId: 30, authorId: 2, createdOn: historicalCreatedOn });
    vi.setSystemTime(new Date(start.getTime() + 180_000));
    const saveVersion = store.saveVersion.bind(store);
    let failOnce = true;
    store.saveVersion = async version => {
      if (failOnce) { failOnce = false; throw new Error('synthetic interruption after project persistence'); }
      await saveVersion(version);
    };
    await expect(service.sync()).rejects.toThrow('synthetic interruption');
    store.saveVersion = saveVersion;
    // The failed sync left the ordinary project catalog partially updated, but not the success marker.
    expect((await store.getProjects()).some(project => project.id === 30)).toBe(true);
    expect(await store.getValue<number[]>('successfulProjectIds')).not.toContain(30);

    vi.setSystemTime(new Date(start.getTime() + 240_000));
    await service.sync();
    expect(await store.hasSeenSourceEvent('issue-created:9201')).toBe(true);
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9201')).toBe(false);
  });

  it('merges defaults and commits creation eligibility against the latest PATCHed subscription', async () => {
    await service.sync();
    const commands = new CommandService(createConfig({ APP_MODE: 'demo' }), store);
    await commands.patchSettings({ subscriptions: { '10': { enabled: true, events: ['issue_created'] } } });
    const createdOn = new Date(Date.now() + 30_000).toISOString();
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9202, authorId: 2, createdOn });

    const readSettings = store.getSettings.bind(store);
    let notifySettingsRead!: () => void;
    let resumeSync!: () => void;
    const settingsRead = new Promise<void>(resolve => { notifySettingsRead = resolve; });
    const barrier = new Promise<void>(resolve => { resumeSync = resolve; });
    let pauseOnce = true;
    store.getSettings = async () => {
      const current = await readSettings();
      if (pauseOnce) { pauseOnce = false; notifySettingsRead(); await barrier; }
      return current;
    };

    const pendingSync = service.sync();
    await settingsRead;
    await commands.patchSettings({ subscriptions: { '10': { enabled: false, events: ['issue_created'] } } });
    resumeSync();
    await pendingSync;
    store.getSettings = readSettings;

    expect((await store.getSettings()).subscriptions['10']).toEqual({ enabled: false, events: ['issue_created'] });
    expect(await store.hasSeenSourceEvent('issue-created:9202')).toBe(true);
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9202')).toBe(false);
  });

  it('honors an opt-out PATCH that commits after sync reads settings but before the event transaction', async () => {
    await service.sync();
    const commands = new CommandService(createConfig({ APP_MODE: 'demo' }), store);
    await commands.patchSettings({ subscriptions: { '10': { enabled: true, events: ['issue_created'] } } });
    snapshot.issues.push({ ...snapshot.issues[0]!, id: 9203, authorId: 2, createdOn: new Date(Date.now() + 30_000).toISOString() });

    const saveIssue = store.saveIssue.bind(store);
    let notifyIssueSaved!: () => void;
    let resumeSync!: () => void;
    const issueSaved = new Promise<void>(resolve => { notifyIssueSaved = resolve; });
    const barrier = new Promise<void>(resolve => { resumeSync = resolve; });
    store.saveIssue = async issue => {
      await saveIssue(issue);
      if (issue.id === 9203) { notifyIssueSaved(); await barrier; }
    };

    const pendingSync = service.sync();
    await issueSaved;
    await commands.patchSettings({ subscriptions: { '10': { enabled: false, events: ['issue_created'] } } });
    resumeSync();
    await pendingSync;
    store.saveIssue = saveIssue;

    expect((await store.getSettings()).subscriptions['10']).toEqual({ enabled: false, events: ['issue_created'] });
    expect(await store.hasSeenSourceEvent('issue-created:9203')).toBe(true);
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9203')).toBe(false);
  });

  it('uses a newly accessible project as a quiet creation baseline', async () => {
    await service.sync();
    const project = { ...snapshot.projects[0]!, id: 30, name: 'Newly accessible', identifier: 'newly-accessible' };
    const createdOn = new Date(Date.now() + 1000).toISOString();
    const issue = { ...snapshot.issues[0]!, id: 9004, projectId: project.id, authorId: 2, createdOn };
    snapshot.projects.push(project);
    snapshot.projectMembers[String(project.id)] = [2];
    snapshot.issues.push(issue);
    const settings = await store.getSettings();
    settings.subscriptions[String(project.id)] = { enabled: true, events: ['issue_created'] };
    await store.setSettings(settings);
    await service.sync();
    expect(await store.hasSeenSourceEvent('issue-created:9004')).toBe(true);
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9004')).toBe(false);

    snapshot.issues.push({ ...issue, id: 9005, createdOn: new Date(Date.now() + 2000).toISOString() });
    await service.sync();
    expect((await store.getNotifications()).some(item => item.id === 'issue-created:9005')).toBe(true);
  });

  it('hides own actions and applies the current event mask to assigned-task activity', async () => {
    await service.sync();
    const settings = await store.getSettings();
    settings.subscriptions = { '10': { enabled: false, events: ['comment', 'assignee'] }, '20': { enabled: false, events: ['comment', 'assignee'] } };
    await store.setSettings(settings);
    snapshot.issues[0].assignedToId = demoMe.id;
    snapshot.journals = [
      { issueId: 1001, journal: journal(72, 1, 'my own') },
      { issueId: 1001, journal: journal(73, 2, 'assigned task comment') },
      { issueId: 1004, journal: { ...journal(74, 3, ''), changes: [{ field: 'assigned_to_id', oldValue: '1', newValue: '2' }] } },
      { issueId: 1005, journal: journal(75, 2, 'unsubscribed') },
      { issueId: 1001, journal: { ...journal(76, 3, ''), changes: [{ field: 'Labels', oldValue: 'Build: Running', newValue: 'Build: Failed' }] } },
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
