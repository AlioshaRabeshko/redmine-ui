import { describe, expect, it } from 'vitest';
import type { Journal, Notification } from '../../../shared/types';
import type { VisibleJournal } from '../../lib/issueActivity';
import { visibleUnreadEvents } from './visibleUnreadEvents';

const actor = { id: 3, name: 'Actor' };

function journal(id: number, notes = 'A visible comment', changes: Journal['changes'] = []): Journal {
  return { id, user: actor, createdOn: '2026-10-05T09:00:00.000Z', notes, changes };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  const id = 801;
  return {
    id: `journal:${id}`, projectId: 12, issueId: 34, journalId: id, actor,
    kind: 'comment', eventKinds: ['comment'], text: 'A visible comment', createdOn: '2026-10-05T09:00:00.000Z',
    ...overrides,
  };
}

function visible(item: Journal, overrides: Partial<VisibleJournal> = {}): VisibleJournal {
  return { journal: item, showComment: Boolean(item.notes.trim()), changes: item.changes, forcedByPermalink: false, ...overrides };
}

describe('visible unread Activity events', () => {
  it('selects only unread notifications for the current issue/project with a rendered journal', () => {
    const current = notification();
    const selected = visibleUnreadEvents({
      issueId: 34,
      projectId: 12,
      notifications: [
        current,
        notification({ id: 'journal:802', journalId: 802, readAt: '2026-10-05T10:00:00.000Z' }),
        notification({ id: 'journal:803', journalId: 803, issueId: 99 }),
        notification({ id: 'journal:804', journalId: 804, projectId: 55 }),
        notification({ id: 'journal:805', journalId: 805, detailsUnavailable: true }),
        notification({ id: 'legacy-no-journal-id', journalId: undefined }),
      ],
      activity: [visible(journal(801))],
    });

    expect(selected).toEqual([{
      notificationId: current.id,
      journalId: 801,
      contentKinds: ['comment'],
      signature: '801:comment',
    }]);
  });

  it('requires every kind in a mixed notification DTO to be rendered by Activity preferences', () => {
    const mixed = notification({ eventKinds: ['comment', 'status', 'labels'] });
    const commentOnlyVisible = visible(journal(801, 'A visible comment'));
    expect(visibleUnreadEvents({
      issueId: 34,
      projectId: 12,
      notifications: [notification({ eventKinds: ['comment', 'status'] })],
      activity: [commentOnlyVisible],
    })).toEqual([]);

    const statusOnlyVisible = visible(journal(801, 'A visible comment', [
      { field: 'status_id', oldValue: '1', newValue: '2' },
    ]));
    expect(visibleUnreadEvents({ issueId: 34, projectId: 12, notifications: [mixed], activity: [statusOnlyVisible] })).toEqual([]);

    const everyKindVisible = visible(journal(801, 'A visible comment', [
      { field: 'status_id', oldValue: '1', newValue: '2' },
      { field: 'Labels', oldValue: 'red', newValue: 'green' },
    ]));
    expect(visibleUnreadEvents({ issueId: 34, projectId: 12, notifications: [mixed], activity: [everyKindVisible] })).toMatchObject([
      { notificationId: 'journal:801', journalId: 801, contentKinds: ['comment', 'status', 'labels'] },
    ]);
  });

  it('keeps buffered, permalink-forced, and hidden event content unread', () => {
    const comment = notification();
    const labelEvent = notification({ id: 'journal:802', journalId: 802, kind: 'labels', eventKinds: ['labels'] });
    const forceVisible = visible(journal(803, 'A permalink-only comment'), { forcedByPermalink: true });
    const labelFiltered = visible(journal(802, 'A mixed comment', [{ field: 'Labels', oldValue: 'a', newValue: 'b' }]), { changes: [] });
    const selected = visibleUnreadEvents({
      issueId: 34,
      projectId: 12,
      notifications: [comment, labelEvent, notification({ id: 'journal:803', journalId: 803 })],
      activity: [visible(journal(801)), labelFiltered, forceVisible],
      bufferedJournalIds: new Set([801]),
      excludedJournalIds: new Set([803]),
    });
    expect(selected).toEqual([]);
  });

  it('uses the exact visible kind for a legacy single-kind notification', () => {
    const label = notification({ id: 'journal:801', kind: 'labels', eventKinds: undefined });
    const item = visible(journal(801, '', [{ field: 'Labels', oldValue: 'old', newValue: 'new' }]), { showComment: false });
    expect(visibleUnreadEvents({ issueId: 34, projectId: 12, notifications: [label], activity: [item] })).toMatchObject([
      { notificationId: 'journal:801', contentKinds: ['labels'] },
    ]);
  });
});
