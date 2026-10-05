import type { Notification } from '../../shared/types';

export interface NotificationGroup {
  issueId: number;
  projectId: number;
  notifications: Notification[];
}

/** Group events by issue, with each event and group ordered by its latest event. */
export function groupNotificationsByIssue(notifications: Notification[]): NotificationGroup[] {
  const groups = new Map<number, Notification[]>();
  for (const notification of notifications) {
    const events = groups.get(notification.issueId) || [];
    events.push(notification);
    groups.set(notification.issueId, events);
  }

  return [...groups.entries()]
    .map(([issueId, events]) => {
      const sortedEvents = [...events].sort(compareNotificationsNewestFirst);
      return {
        issueId,
        projectId: sortedEvents[0]!.projectId,
        notifications: sortedEvents,
      };
    })
    .sort((a, b) => compareNotificationsNewestFirst(a.notifications[0]!, b.notifications[0]!) || b.issueId - a.issueId);
}

function compareNotificationsNewestFirst(a: Notification, b: Notification): number {
  const aTime = Date.parse(a.createdOn);
  const bTime = Date.parse(b.createdOn);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if ((!Number.isFinite(aTime) || !Number.isFinite(bTime)) && a.createdOn !== b.createdOn) return b.createdOn.localeCompare(a.createdOn);

  const aNumericId = Number(a.id.match(/(\d+)$/)?.[1]);
  const bNumericId = Number(b.id.match(/(\d+)$/)?.[1]);
  if (Number.isFinite(aNumericId) && Number.isFinite(bNumericId) && aNumericId !== bNumericId) return bNumericId - aNumericId;
  return b.id.localeCompare(a.id);
}
