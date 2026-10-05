import { afterEach, describe, expect, it } from 'vitest';
import type { Journal, Notification } from '../shared/types.js';
import { createApp, type WorkspaceApp } from './app.js';

describe('notifications API cache projection', () => {
  let app: WorkspaceApp | undefined;
  afterEach(async () => {
    if (app) { app.backend.stop(); await app.close(); app = undefined; }
  });

  it('hydrates old rows locally, applies event masks at read time, and preserves IDs and read state', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    const { store } = app.backend;
    const settings = await store.getSettings();
    settings.subscriptions['10'] = { enabled: false, events: ['comment'] };
    await store.setSettings(settings);

    const issue = await store.getIssue(1001);
    expect(issue).toBeDefined();
    const journal: Journal = {
      id: 99001, user: { id: 3, name: 'QA Person' }, notes: 'Mixed journal comment.',
      createdOn: '2026-10-05T08:00:00.000Z', changes: [
        { field: 'status_id', oldValue: '4', newValue: '5' },
        { field: 'assigned_to_id', oldValue: '2', newValue: '3' },
        { field: 'Labels', oldValue: '606', newValue: '607' },
      ],
    };
    await store.saveJournal(issue!.id, journal);
    await store.setValue('labelOptions', { '10': [{ id: '606', name: 'Build: Running' }, { id: '607', name: 'Build: Failed' }] });
    const oldNotification: Notification = {
      id: 'persisted-event-keep-this-id', projectId: 10, issueId: issue!.id, journalId: journal.id,
      actor: journal.user, kind: 'labels', text: 'status_id: 4 → 5; assigned_to_id: 2 → 3',
      createdOn: journal.createdOn, readAt: '2026-10-05T09:00:00.000Z',
    };
    await store.saveNotification(oldNotification);

    const commentsOnly = await app.inject({ method: 'GET', url: '/api/notifications?archived=true' });
    expect(commentsOnly.statusCode).toBe(200);
    const commentResult = commentsOnly.json<Notification[]>()[0]!;
    expect(commentResult).toMatchObject({
      id: oldNotification.id, issueSubject: issue!.subject, createdOn: oldNotification.createdOn,
      readAt: oldNotification.readAt, kind: 'comment', notes: journal.notes, changes: [], eventKinds: ['comment'],
    });
    expect(JSON.stringify(commentResult)).not.toContain('status_id');
    expect(JSON.stringify(commentResult)).not.toContain('assigned_to_id');

    settings.subscriptions['10'] = { enabled: false, events: ['labels'] };
    await store.setSettings(settings);
    const labelsOnly = await app.inject({ method: 'GET', url: '/api/notifications?archived=true' });
    const labelResult = labelsOnly.json<Notification[]>()[0]!;
    expect(labelResult).toMatchObject({
      id: oldNotification.id, readAt: oldNotification.readAt, kind: 'labels',
      changes: [{ field: 'Labels', oldValue: '606', newValue: '607' }], eventKinds: ['labels'],
      changeLookups: { labels: [{ id: '606', name: 'Build: Running' }, { id: '607', name: 'Build: Failed' }] },
    });
    expect(labelResult).not.toHaveProperty('notes');

    settings.subscriptions['10'] = { enabled: false, events: [] };
    await store.setSettings(settings);
    const hidden = await app.inject({ method: 'GET', url: '/api/notifications?archived=true' });
    expect(hidden.json()).toEqual([]);
    const persisted = (await store.getNotifications(true)).find((item) => item.id === oldNotification.id);
    expect(persisted).toMatchObject({ id: oldNotification.id, readAt: oldNotification.readAt, text: oldNotification.text });
  });
});
