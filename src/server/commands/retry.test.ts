import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../db/connection.js';
import { WorkspaceStore } from '../db/store.js';
import { createConfig } from '../config.js';
import { CommandService } from './service.js';

describe('durable command retry envelopes', () => {
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

  it('restores a failed create payload when the UI retries with the persisted issue ID and empty input', async () => {
    const persist = store.saveOperationRecord.bind(store);
    let failOnce = true;
    const spy = vi.spyOn(store, 'saveOperationRecord').mockImplementation(async record => {
      if (failOnce && record.operation.type === 'createIssue' && record.operation.status === 'done') {
        failOnce = false;
        throw new Error('Simulated interruption after the issue was saved');
      }
      return persist(record);
    });
    const failed = await commands.execute({ type: 'createIssue', projectId: 10, operationId: 'ui-retry-create', input: { subject: 'Retry from activity drawer' } });
    spy.mockRestore();
    expect(failed.operation.status).toBe('failed');
    const resumed = await commands.execute({ type: 'createIssue', issueId: failed.operation.issueId, operationId: failed.operation.id, input: {} });
    expect(resumed.operation.status).toBe('done');
    expect(resumed.issue).toMatchObject({ id: failed.operation.issueId, projectId: 10, subject: 'Retry from activity drawer' });
    expect((await store.getIssues()).filter(issue => issue.subject === 'Retry from activity drawer')).toHaveLength(1);
  });
});
