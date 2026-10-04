import { describe, expect, it } from 'vitest';
import { defaultActivityVisibility, type Journal, type LabelOption } from '../../shared/types';
import { activityKindForField, localizeJournalChange, visibleJournals } from './issueActivity';

const journal: Journal = {
  id: 42,
  user: { id: 1, name: 'Pat Example' },
  notes: 'A comment stays visible alongside allowed changes.',
  createdOn: '2026-10-04T10:00:00Z',
  changes: [
    { field: 'status_id', oldValue: '901', newValue: '902' },
    { field: 'assigned_to_id', oldValue: '801', newValue: '802' },
    { field: 'Labels', oldValue: '606', newValue: '607' },
    { field: 'Priority', oldValue: '3' },
  ],
};

const translations: Record<string, string> = {
  status: 'Status', assignee: 'Assignee', labels: 'Labels', priorityField: 'Priority', release: 'Release',
  noAssignee: 'Unassigned', cleared: 'Cleared', unknown: 'Unknown',
};
const t = (key: string) => translations[key] ?? key;

describe('issue activity visibility and journal text', () => {
  it('classifies Redmine field names by user-facing activity type', () => {
    expect(activityKindForField('status_id')).toBe('status');
    expect(activityKindForField('assigned_to_id')).toBe('assignee');
    expect(activityKindForField('Labels')).toBe('labels');
    expect(activityKindForField('cf_902')).toBe('field');
  });

  it('filters changes independently while preserving a visible mixed-entry comment', () => {
    const [filtered] = visibleJournals([journal], defaultActivityVisibility);
    expect(filtered?.showComment).toBe(true);
    expect(filtered?.changes.map((change) => change.field)).toEqual(['status_id', 'assigned_to_id']);
  });

  it('hides comments without removing allowed status or assignee changes', () => {
    const [filtered] = visibleJournals([journal], { ...defaultActivityVisibility, comment: false });
    expect(filtered?.showComment).toBe(false);
    expect(filtered?.changes.map((change) => change.field)).toEqual(['status_id', 'assigned_to_id']);
  });

  it('reveals a journal permalink target without changing the project visibility object', () => {
    const hidden: Journal = { ...journal, id: 8, notes: 'Targeted note', changes: [{ field: 'Labels', oldValue: '606' }] };
    const visibility = { ...defaultActivityVisibility, comment: false };
    const originalVisibility = { ...visibility };
    expect(visibleJournals([hidden], visibility)).toEqual([]);
    expect(visibleJournals([hidden], visibility, hidden.id)).toMatchObject([{ showComment: true, forcedByPermalink: true, changes: hidden.changes }]);
    expect(visibility).toEqual(originalVisibility);
  });

  it('uses known names, explicit ID fallbacks, and cleared labels for missing values', () => {
    const labels: LabelOption[] = [{ id: '606', name: 'Build: Succeeded' }, { id: '607', name: 'Build: Failed' }];
    const lookups = {
      statuses: [{ id: 901, name: 'QA', key: 'qa' as const, isClosed: false }, { id: 902, name: 'To Do', key: 'todo' as const, isClosed: false }],
      people: [{ id: 801, name: 'example-user-a' }, { id: 802, name: 'example-user-b' }],
      priorities: [],
      versions: [],
      labels,
    };
    expect(localizeJournalChange(journal.changes[0]!, lookups, t)).toEqual({ field: 'Status', oldValue: 'QA', newValue: 'To Do' });
    expect(localizeJournalChange(journal.changes[1]!, lookups, t)).toEqual({ field: 'Assignee', oldValue: 'example-user-a', newValue: 'example-user-b' });
    expect(localizeJournalChange(journal.changes[2]!, lookups, t)).toEqual({ field: 'Labels', oldValue: 'Build: Succeeded', newValue: 'Build: Failed' });
    expect(localizeJournalChange({ field: 'status_id', newValue: '999' }, lookups, t).oldValue).toBe('Cleared');
    expect(localizeJournalChange({ field: 'Labels', oldValue: '666' }, lookups, t).oldValue).toBe('Unknown (#666)');
    const collidingFields = { ...lookups, labels: [
      { id: '606', name: 'Build: Succeeded', fieldId: 41 },
      { id: '606', name: 'A different tag', fieldId: 42 },
    ] };
    expect(localizeJournalChange({ field: 'Labels', oldValue: '606' }, collidingFields, t).oldValue).toBe('Unknown (#606)');
  });
});
