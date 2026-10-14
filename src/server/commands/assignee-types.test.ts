import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type WorkspaceApp } from '../app.js';

describe('demo typed assignee persistence', () => {
  let app: WorkspaceApp | undefined;
  afterEach(async () => {
    if (app) { app.backend.stop(); await app.close(); app = undefined; }
  });

  it('keeps a group distinct from a same-numbered user, updates type/name, and clears all assignee metadata', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    const created = await app.backend.commands.execute({ type: 'createIssue', projectId: 10, input: {
      subject: 'Typed group assignment', assignedToId: 2, assignedToType: 'group',
    } });
    expect(created.issue).toMatchObject({ assignedToId: 2, assignedToType: 'group', assignedToName: 'Platform group' });
    expect(created.issue?.developerId).toBeUndefined();

    const changed = await app.backend.commands.execute({ type: 'updateIssue', issueId: created.issue!.id, input: {
      assignedToId: 2, assignedToType: 'user',
    } });
    expect(changed.issue).toMatchObject({ assignedToId: 2, assignedToType: 'user', assignedToName: 'Example Person B Мельник' });

    const cleared = await app.backend.commands.execute({ type: 'updateIssue', issueId: created.issue!.id, input: { assignedToId: null } });
    expect(cleared.issue).not.toHaveProperty('assignedToId');
    expect(cleared.issue).not.toHaveProperty('assignedToType');
    expect(cleared.issue).not.toHaveProperty('assignedToName');
  });
});
