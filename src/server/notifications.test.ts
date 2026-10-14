import { describe, expect, it } from 'vitest';
import type { Journal, Notification, SubscriptionEvent } from '../shared/types.js';
import { defaultSettings } from './settings.js';
import { projectNotification, resolveNotificationEligibility } from './notifications.js';

const source: Journal = {
  id: 301,
  user: { id: 7, name: 'Actor' },
  notes: 'A comment remains visible in comments-only mode.',
  createdOn: '2026-10-05T09:00:00Z',
  changes: [
    { field: 'status_id', oldValue: '910', newValue: '911' },
    { field: 'assigned_to_id', oldValue: '7', newValue: '8' },
    { field: 'Labels', oldValue: '606', newValue: '607' },
  ],
};

const stored: Notification = {
  id: 'journal:301', projectId: 5, issueId: 20, journalId: source.id, actor: source.user,
  kind: 'labels', text: 'status_id: 910 → 911', createdOn: source.createdOn, readAt: '2026-10-05T10:00:00Z',
};

function data(events?: SubscriptionEvent[]) {
  const settings = structuredClone(defaultSettings);
  if (events !== undefined) settings.subscriptions['5'] = { enabled: false, events };
  else delete settings.subscriptions['5'];
  return {
    issues: [{ id: 20, projectId: 5, subject: 'Current cached subject', description: '', statusId: 910, priorityId: 1, trackerId: 1,
      trackerName: 'Bug', authorId: 7, branch: '', labels: [], watcherIds: [], createdOn: source.createdOn,
      updatedOn: source.createdOn, attachments: [] }],
    journalsByIssue: new Map([[20, [source]]]),
    statuses: [{ id: 910, name: 'Open', key: 'todo' as const, isClosed: false }, { id: 911, name: 'Review', key: 'review' as const, isClosed: false }],
    people: [{ id: 7, name: 'Actor' }, { id: 8, name: 'Assignee' }],
    priorities: [], versions: [], labelOptions: { '5': [{ id: '606', name: 'Build: Running' }, { id: '607', name: 'Build: Failed' }], '6': [{ id: '607', name: 'Other project label' }] },
    settings,
  };
}

describe('notification projection', () => {
  it('keeps assigned issues eligible while applying comments-only and explicit empty event masks', () => {
    const kinds = ['comment', 'labels'] as const;
    expect(resolveNotificationEligibility([...kinds], { enabled: false, events: ['comment'] }, true)).toEqual({
      eligible: true, visibleKinds: ['comment'],
    });
    expect(resolveNotificationEligibility([...kinds], { enabled: false, events: ['comment'] }, false)).toEqual({
      eligible: false, visibleKinds: ['comment'],
    });
    expect(resolveNotificationEligibility([...kinds], { enabled: false, events: [] }, true)).toEqual({
      eligible: true, visibleKinds: [],
    });
    expect(resolveNotificationEligibility([...kinds], undefined, true)).toEqual({
      eligible: true, visibleKinds: ['comment'],
    });
  });

  it('hydrates legacy rows from local issue journals and applies comments-only to mixed content', () => {
    const projected = projectNotification(stored, data(['comment']))!;
    expect(projected).toMatchObject({
      id: stored.id, journalId: stored.journalId, issueId: stored.issueId, createdOn: stored.createdOn,
      readAt: stored.readAt, issueSubject: 'Current cached subject', kind: 'comment',
      notes: source.notes, changes: [], eventKinds: ['comment'],
    });
  });

  it('reprojects retained unread source details after preferences change without changing read state', () => {
    const projected = projectNotification(stored, data(['labels']))!;
    expect(projected).toMatchObject({
      id: stored.id, readAt: stored.readAt, notes: undefined, kind: 'labels', eventKinds: ['labels'],
      changes: [{ field: 'Labels', oldValue: '606', newValue: '607' }],
      changeLookups: { labels: [{ id: '606', name: 'Build: Running' }, { id: '607', name: 'Build: Failed' }] },
    });
    expect(projected.changeLookups?.labels).not.toContainEqual({ id: '607', name: 'Other project label' });
  });

  it('uses comments as the default only when a project has no explicit event mask', () => {
    expect(projectNotification(stored, data())?.notes).toBe(source.notes);
    expect(projectNotification(stored, data([]))).toBeUndefined();
  });

  it('keeps old comment-only rows readable when their source journal has left the cache', () => {
    const legacyComment = { ...stored, id: 'legacy-opaque-id', journalId: undefined, kind: 'comment', text: 'A persisted comment.' };
    const context = data(['comment']);
    context.journalsByIssue.clear();
    const projected = projectNotification(legacyComment, context)!;
    expect(projected.notes).toBe('A persisted comment.');
    expect(projected.id).toBe('legacy-opaque-id');
    expect(projected.readAt).toBe(stored.readAt);
  });
});
