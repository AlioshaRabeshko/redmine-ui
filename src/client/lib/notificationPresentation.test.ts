import { describe, expect, it } from 'vitest';
import { presentNotification } from './notificationPresentation';
import type { Notification } from '../../shared/types';

const strings: Record<string, string> = {
  status: 'Status', assignee: 'Assignee', labels: 'Labels', priorityField: 'Priority', release: 'Release',
  noAssignee: 'Unassigned', cleared: 'Cleared', unknown: 'Unknown', notificationDetailsUnavailable: 'Details unavailable',
};
const t = (key: string) => strings[key] ?? key;

function notification(overrides: Partial<Notification> = {}): Notification {
  return { id: 'journal:42', projectId: 5, issueId: 12, journalId: 42, actor: { id: 2, name: 'Actor' },
    kind: 'status', text: 'status_id: 901 → 902', createdOn: '2026-10-05T10:00:00Z', ...overrides };
}

describe('notification presentation', () => {
  it('uses the shared Activity renderer for fields and project lookups', () => {
    const view = presentNotification(notification({
      notes: 'A note',
      changes: [
        { field: 'status_id', oldValue: '901', newValue: '902' },
        { field: 'assigned_to_id', oldValue: '21', newValue: '22' },
        { field: 'Labels', oldValue: '61', newValue: '62' },
      ],
      changeLookups: {
        statuses: [{ id: 901, name: 'QA', key: 'qa', isClosed: false }, { id: 902, name: 'To Do', key: 'todo', isClosed: false }],
        people: [{ id: 21, name: 'Asha' }, { id: 22, name: 'Borys' }],
        labels: [{ id: '61', name: 'Build: Running' }, { id: '62', name: 'Build: Failed' }],
      },
    }), t);

    expect(view.notes).toBe('A note');
    expect(view.changes).toEqual([
      { field: 'Status', oldValue: 'QA', newValue: 'To Do' },
      { field: 'Assignee', oldValue: 'Asha', newValue: 'Borys' },
      { field: 'Labels', oldValue: 'Build: Running', newValue: 'Build: Failed' },
    ]);
    expect(view.fallback).toBeUndefined();
  });

  it('keeps old comments readable and never exposes raw ID summaries when source details are missing', () => {
    expect(presentNotification(notification({ kind: 'comment', text: 'Legacy comment text' }), t)).toMatchObject({
      notes: 'Legacy comment text', changes: [], fallback: undefined,
    });
    expect(presentNotification(notification(), t)).toMatchObject({
      notes: '', changes: [], fallback: 'Details unavailable',
    });
  });

  it('labels unknown numeric values without guessing a catalog name', () => {
    const view = presentNotification(notification({ changes: [{ field: 'status_id', oldValue: '999' }] }), t);
    expect(view.changes[0]).toEqual({ field: 'Status', oldValue: 'Unknown (#999)', newValue: 'Cleared' });
  });
});
