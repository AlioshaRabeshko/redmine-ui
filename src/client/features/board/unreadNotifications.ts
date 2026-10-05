import type { Notification } from '../../../shared/types';

/** Group only unread events so the board and its filter share the same source of truth. */
export function groupUnreadNotifications(notifications: Notification[]): Map<number, Notification[]> {
  const grouped = new Map<number, Notification[]>();
  for (const notification of notifications) {
    if (notification.readAt) continue;
    const events = grouped.get(notification.issueId) || [];
    events.push(notification);
    grouped.set(notification.issueId, events);
  }
  for (const events of grouped.values()) events.sort(compareOldestFirst);
  return grouped;
}

export function oldestUnreadNotification(notifications: Notification[] | undefined): Notification | undefined {
  return notifications?.[0];
}

function compareOldestFirst(left: Notification, right: Notification): number {
  const leftTime = Date.parse(left.createdOn);
  const rightTime = Date.parse(right.createdOn);
  const timeDifference = Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime - rightTime
    : left.createdOn.localeCompare(right.createdOn);
  if (timeDifference) return timeDifference;
  const journalDifference = (left.journalId ?? Number.MAX_SAFE_INTEGER) - (right.journalId ?? Number.MAX_SAFE_INTEGER);
  return journalDifference || left.id.localeCompare(right.id);
}
