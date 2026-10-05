import { describe, expect, it } from 'vitest';
import type { Notification } from '../../../shared/types';
import { groupUnreadNotifications, oldestUnreadNotification } from './unreadNotifications';

const actor = { id: 1, name: 'Reviewer' };
const notification = (id: string, issueId: number, createdOn: string, journalId: number, readAt?: string): Notification => ({
  id, issueId, projectId: 3, journalId, createdOn, readAt, actor, kind: 'comment', text: id,
});

describe('board unread notification index', () => {
  it('counts unread events only and selects the oldest event with deterministic ties', () => {
    const grouped = groupUnreadNotifications([
      notification('latest', 42, '2026-10-05T12:00:00Z', 120),
      notification('middle', 42, '2026-10-05T11:00:00Z', 110),
      notification('older-high-id', 42, '2026-10-05T10:00:00Z', 102),
      notification('older-low-id', 42, '2026-10-05T10:00:00Z', 101),
      notification('read', 42, '2026-10-05T09:00:00Z', 90, '2026-10-05T13:00:00Z'),
      notification('other-issue', 77, '2026-10-05T10:00:00Z', 77),
    ]);

    expect(grouped.get(42)?.map(item => item.id)).toEqual(['older-low-id', 'older-high-id', 'middle', 'latest']);
    expect(oldestUnreadNotification(grouped.get(42))?.id).toBe('older-low-id');
    expect(grouped.get(77)).toHaveLength(1);
    expect(grouped.has(999)).toBe(false);
  });

  it('does not create an unread index entry for issues with only read events', () => {
    expect(groupUnreadNotifications([
      notification('read', 42, '2026-10-05T10:00:00Z', 10, '2026-10-05T11:00:00Z'),
    ])).toEqual(new Map());
    expect(oldestUnreadNotification(undefined)).toBeUndefined();
  });
});
