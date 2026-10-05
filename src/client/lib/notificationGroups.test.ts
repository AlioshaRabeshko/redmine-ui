import { describe, expect, it } from 'vitest';
import type { Notification } from '../../shared/types';
import { groupNotificationsByIssue } from './notificationGroups';

function notification(id: number, issueId: number, createdOn: string): Notification {
  return {
    id: `journal:${id}`,
    projectId: 7,
    issueId,
    journalId: id,
    actor: { id: 1, name: 'Example User' },
    kind: 'comment',
    text: `Event ${id}`,
    createdOn,
  };
}

describe('notification groups', () => {
  it('groups by issue and orders groups and events by newest event first', () => {
    const source = [
      notification(7, 101, '2026-10-02T10:00:00Z'),
      notification(4, 202, '2026-10-04T10:00:00Z'),
      notification(8, 101, '2026-10-04T10:00:00Z'),
      notification(6, 101, '2026-10-04T10:00:00Z'),
    ];

    const groups = groupNotificationsByIssue(source);
    expect(groups.map(({ issueId }) => issueId)).toEqual([101, 202]);
    expect(groups[0]?.notifications.map(({ id }) => id)).toEqual(['journal:8', 'journal:6', 'journal:7']);
    expect(source.map(({ id }) => id)).toEqual(['journal:7', 'journal:4', 'journal:8', 'journal:6']);
  });

  it('keeps unread and archived state attached to each original notification', () => {
    const unread = notification(10, 101, '2026-10-04T10:00:00Z');
    const archived = { ...notification(9, 101, '2026-10-03T10:00:00Z'), readAt: '2026-10-04T10:01:00Z' };

    expect(groupNotificationsByIssue([unread, archived])[0]?.notifications).toEqual([unread, archived]);
    expect(groupNotificationsByIssue([unread, archived])[0]?.notifications.filter((event) => !event.readAt).map((event) => event.id)).toEqual(['journal:10']);
  });
});
