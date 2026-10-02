import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../src/server/db/connection.js';
import { WorkspaceStore } from '../src/server/db/store.js';
import { createConfig } from '../src/server/config.js';
import { CommandService } from '../src/server/commands/service.js';
import type { Command, Issue } from '../src/shared/types.js';

describe('durable workspace commands using isolated SQLite', () => {
  let close: () => void;
  let store: WorkspaceStore;
  let commands: CommandService;
  beforeEach(async () => {
    const database = openDatabase(':memory:');
    close = database.close;
    migrate(database.db, { migrationsFolder: 'drizzle' });
    store = new WorkspaceStore(database.db, 'demo:isolated');
    await store.initializeDemo();
    commands = new CommandService(createConfig({ APP_MODE: 'demo' }), store);
  });
  afterEach(() => close());
  const move = (issueId: number, input: Record<string, unknown>): Command => ({ type: 'moveIssue', issueId, input });

  it('handoff and modal updates share QA/return rules and preserve the developer', async () => {
    const handoff = await commands.execute({ type: 'updateIssue', issueId: 1001, input: { statusId: 5, qaId: 3 } });
    expect(handoff.operation.status).toBe('done');
    expect(await store.getIssue(1001)).toMatchObject({ statusId: 5, assignedToId: 3, developerId: 2, fixedVersionId: 100 });
    expect(handoff.operation.steps.filter(step => step.status === 'done')).toHaveLength(3);
    const returned = await commands.execute(move(1001, { statusId: 2 }));
    expect(returned.operation.status).toBe('done');
    expect(await store.getIssue(1001)).toMatchObject({ statusId: 2, assignedToId: 2, developerId: 2, fixedVersionId: 100 });
  });

  it('explicit roadmap removal also works during compound QA/return commands', async () => {
    await commands.execute(move(1001, { statusId: 5, removeVersion: true }));
    expect((await store.getIssue(1001))?.fixedVersionId).toBeUndefined();
    await commands.execute({ type: 'updateIssue', issueId: 1001, input: { fixedVersionId: 100 } });
    await commands.execute(move(1001, { statusId: 2, removeVersion: true }));
    expect((await store.getIssue(1001))?.fixedVersionId).toBeUndefined();
  });

  it('dropping into a release changes membership while retaining actual status', async () => {
    const result = await commands.execute(move(1004, { fixedVersionId: 100 }));
    expect(result.operation.status).toBe('done');
    expect(await store.getIssue(1004)).toMatchObject({ statusId: 2, fixedVersionId: 100 });
  });

  it('invalid versions/statuses cannot partially persist an edit', async () => {
    const original = await store.getIssue(1004);
    await expect(commands.execute({ type: 'updateIssue', issueId: 1004, input: { subject: 'must not save', fixedVersionId: 999999 } })).rejects.toMatchObject({ statusCode: 400 });
    expect(await store.getIssue(1004)).toEqual(original);
    await expect(commands.execute({ type: 'updateIssue', issueId: 1004, input: { subject: 'must not save', statusId: 999999 } })).rejects.toMatchObject({ statusCode: 400 });
    expect(await store.getIssue(1004)).toEqual(original);
    expect((await store.getOperations()).every(op => op.status !== 'running')).toBe(true);
  });

  it('requires a known developer rather than guessing on return', async () => {
    const issue = (await store.getIssue(1001))!;
    await store.setIssueRoles(issue.id, null, issue.qaId);
    const result = await commands.execute(move(issue.id, { statusId: 2 }));
    expect(result.operation.status).toBe('blocked');
    expect((await store.getIssue(issue.id))?.statusId).toBe(4);
    await commands.saveIssueRoles(issue.id, { developerId: 2 });
    const retry = await commands.execute(move(issue.id, { statusId: 2 }));
    expect(retry.operation.status).toBe('done');
  });

  it('closes Deploy tasks, skips Done, ignores CI labels, and retains release history', async () => {
    const done = (await store.getIssue(1010))!;
    await store.saveIssue({ ...done, fixedVersionId: 101 });
    for (const id of [1002, 1009]) await store.saveIssue({ ...(await store.getIssue(id))!, statusId: 6 });
    const result = await commands.execute({ type: 'finishRelease', versionId: 101, input: {} });
    expect(result.operation.status).toBe('done');
    expect((await store.getVersion(101))?.status).toBe('closed');
    const tasks = (await store.getIssues(10)).filter(issue => issue.fixedVersionId === 101);
    expect(tasks).toHaveLength(5);
    expect(tasks.every(issue => issue.statusId === 7)).toBe(true);
    expect(result.operation.steps.some(step => step.status === 'skipped')).toBe(true);
    expect((await store.getIssue(1012))?.labels).toContain('Build: Failed');
  });

  it('blocks a release with QA or Rejected and rejects cross-project additions', async () => {
    const result = await commands.execute({ type: 'finishRelease', versionId: 101, input: {} });
    expect(result.operation.status).toBe('blocked');
    expect((await store.getVersion(101))?.status).toBe('open');
    await expect(commands.execute({ type: 'assignRelease', versionId: 101, input: { issueIds: [2001] } })).rejects.toMatchObject({ statusCode: 400 });
    expect((await store.getIssue(2001))?.fixedVersionId).toBe(200);
  });

  it('replays a completed operation without duplicate cards and rejects conflicting reuse', async () => {
    const command: Command = { type: 'createIssue', projectId: 10, operationId: 'creation-id', input: { subject: 'Unique issue' } };
    const first = await commands.execute(command);
    const again = await commands.execute(command);
    expect(again.issue?.id).toBe(first.issue?.id);
    expect((await store.getIssues()).filter(issue => issue.subject === 'Unique issue')).toHaveLength(1);
    await expect(commands.execute({ ...command, type: 'comment', issueId: 1001, input: { notes: 'conflict' } })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('serializes concurrent creations from separate tabs into distinct IDs', async () => {
    const results = await Promise.all(['First concurrent', 'Second concurrent'].map(subject => commands.execute({ type: 'createIssue', projectId: 10, input: { subject } })));
    expect(new Set(results.map(result => result.issue?.id)).size).toBe(2);
    expect(results.every(result => result.operation.status === 'done')).toBe(true);
    expect((await store.getIssues()).filter(issue => issue.subject.includes('concurrent'))).toHaveLength(2);
  });

  it('retries a blocked release after its remaining task reaches Deploy', async () => {
    const command: Command = { type: 'finishRelease', versionId: 101, operationId: 'retry-release', input: {} };
    expect((await commands.execute(command)).operation.status).toBe('blocked');
    for (const id of [1002, 1009]) await commands.execute({ type: 'updateIssue', issueId: id, input: { statusId: 6 } });
    const result = await commands.execute({ ...command, input: {} });
    expect(result.operation.status).toBe('done');
    expect((await store.getVersion(101))?.status).toBe('closed');
  });

  it('resumes a failed creation from its stored input without creating a duplicate', async () => {
    const persist = store.saveOperationRecord.bind(store);
    let failOnce = true;
    const spy = vi.spyOn(store, 'saveOperationRecord').mockImplementation(async record => {
      if (failOnce && record.operation.type === 'createIssue' && record.operation.status === 'done') {
        failOnce = false;
        throw new Error('Simulated interruption after the issue was saved');
      }
      return persist(record);
    });
    const result = await commands.execute({ type: 'createIssue', projectId: 10, operationId: 'interrupted-create', input: { subject: 'Durable retry' } });
    expect(result.operation.status).toBe('failed');
    spy.mockRestore();
    const resumed = await commands.execute({ type: 'createIssue', operationId: 'interrupted-create', input: {} });
    expect(resumed.operation.status).toBe('done');
    expect(resumed.issue?.subject).toBe('Durable retry');
    expect((await store.getIssues()).filter(issue => issue.subject === 'Durable retry')).toHaveLength(1);
  });

  it('archives exactly the selected notification and persists appearance locally', async () => {
    const items = await store.getNotifications();
    expect(items.length).toBeGreaterThan(1);
    await store.markNotificationsRead([items[0].id]);
    expect((await store.getNotifications()).map(item => item.id)).not.toContain(items[0].id);
    expect((await store.getNotifications(true)).map(item => item.id)).toEqual([items[0].id]);
    await commands.saveSettings({ ...(await store.getSettings()), locale: 'es', theme: 'dark', palette: 'green' });
    expect(await store.getSettings()).toMatchObject({ locale: 'es', theme: 'dark', palette: 'green' });
  });

  it('queues only the CI transition, then runs without a browser and retains NEXT', async () => {
    await commands.execute({ type: 'runAutomation', issueId: 1008, input: {} });
    expect((await store.getIssue(1008))?.statusId).toBe(4); // Failed alone is not evidence of a transition.
    await commands.execute({ type: 'updateIssue', issueId: 1001, input: { labels: ['Build: Failed'] } });
    expect((await store.getOperations()).some(op => op.type === 'runAutomation' && op.issueId === 1001 && op.status === 'pending')).toBe(true);
    await commands.processPendingDemoAutomations();
    expect(await store.getIssue(1001)).toMatchObject({ statusId: 2, assignedToId: 2, developerId: 2, fixedVersionId: 100 });
    expect(await commands.processPendingDemoAutomations()).toEqual([]);
  });

  it('disabled automation does not queue an action from a CI change', async () => {
    await commands.saveSettings({ ...(await store.getSettings()), automationEnabled: false });
    await commands.execute({ type: 'updateIssue', issueId: 1001, input: { labels: ['Build: Failed'] } });
    expect((await store.getOperations()).filter(op => op.type === 'runAutomation')).toEqual([]);
    await commands.processPendingDemoAutomations();
    expect((await store.getIssue(1001))?.statusId).toBe(4);
  });

  it('rejects every external write command before touching the local issue', async () => {
    const real = new CommandService(createConfig({ APP_MODE: 'redmine', REDMINE_API_TOKEN: 'fake-test-key', REDMINE_URL: 'https://example.invalid' }), store);
    const types: Command['type'][] = ['createIssue', 'updateIssue', 'moveIssue', 'handoffToQA', 'returnToDeveloper', 'comment', 'createRelease', 'updateRelease', 'assignRelease', 'finishRelease', 'runAutomation'];
    const before: Issue[] = await store.getIssues();
    for (const type of types) await expect(real.execute({ type, issueId: 1001, projectId: 10, versionId: 100, input: {} })).rejects.toMatchObject({ statusCode: 403, code: 'READ_ONLY' });
    expect(await store.getIssues()).toEqual(before);
  });
});
