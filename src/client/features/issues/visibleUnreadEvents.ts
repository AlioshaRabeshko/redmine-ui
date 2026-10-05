import type { ActivityKind, Notification } from '../../../shared/types';
import { activityKindForField, type VisibleJournal } from '../../lib/issueActivity';

export interface VisibleUnreadEvent {
  notificationId: string;
  journalId: number;
  contentKinds: ActivityKind[];
  signature: string;
}

export interface VisibleUnreadEventOptions {
  issueId: number;
  projectId: number;
  notifications: Notification[];
  activity: VisibleJournal[];
  bufferedJournalIds?: ReadonlySet<number>;
  excludedJournalIds?: ReadonlySet<number>;
}

/** Select only unread notification IDs whose complete event-kind projection is currently rendered. */
export function visibleUnreadEvents({
  issueId,
  projectId,
  notifications,
  activity,
  bufferedJournalIds = new Set(),
  excludedJournalIds = new Set(),
}: VisibleUnreadEventOptions): VisibleUnreadEvent[] {
  const visibleByJournal = new Map<number, VisibleJournal>();
  for (const item of activity) visibleByJournal.set(item.journal.id, item);

  const seen = new Set<string>();
  const result: VisibleUnreadEvent[] = [];
  for (const notification of notifications) {
    if (!notification.id || notification.readAt || notification.issueId !== issueId || notification.projectId !== projectId
      || notification.detailsUnavailable || seen.has(notification.id)) continue;

    const journalId = notification.journalId ?? journalIdFromNotificationId(notification.id);
    if (journalId === undefined || !Number.isSafeInteger(journalId) || journalId <= 0
      || bufferedJournalIds.has(journalId) || excludedJournalIds.has(journalId)) continue;

    const item = visibleByJournal.get(journalId);
    if (!item || item.forcedByPermalink) continue;

    const kinds = notificationKinds(notification);
    if (!kinds.length) continue;
    const displayedKinds = new Set<ActivityKind>();
    if (item.showComment && item.journal.notes.trim()) displayedKinds.add('comment');
    for (const change of item.changes) displayedKinds.add(activityKindForField(change.field));
    if (!kinds.every((kind) => displayedKinds.has(kind))) continue;

    const contentKinds = kinds.filter((kind) => displayedKinds.has(kind));
    if (contentKinds.length !== kinds.length) continue;
    seen.add(notification.id);
    result.push({
      notificationId: notification.id,
      journalId,
      contentKinds,
      signature: `${journalId}:${kinds.join(',')}`,
    });
  }
  return result;
}

function notificationKinds(notification: Notification): ActivityKind[] {
  const kinds: unknown[] = notification.eventKinds === undefined
    ? [notification.kind]
    : notification.eventKinds;
  const normalized = kinds.filter(isActivityKind);
  if (!normalized.length || normalized.length !== kinds.length) return [];
  return [...new Set(normalized)];
}

function isActivityKind(value: unknown): value is ActivityKind {
  return value === 'comment' || value === 'status' || value === 'assignee' || value === 'labels' || value === 'field';
}

function journalIdFromNotificationId(id: string): number | undefined {
  const match = id.match(/^journal:(\d+)$/);
  return match ? Number(match[1]) : undefined;
}
