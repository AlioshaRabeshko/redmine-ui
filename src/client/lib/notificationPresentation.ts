import type { Notification } from '../../shared/types';
import { localizeJournalChange, type ChangeLookups, type LocalizedChange } from './issueActivity';

export interface NotificationPresentation {
  notes: string;
  changes: LocalizedChange[];
  fallback?: string;
}

/** Render structured source details through the same lookup and localization path as issue Activity. */
export function presentNotification(notification: Notification, translate: (key: string) => string): NotificationPresentation {
  const notes = (notification.notes ?? (notification.kind.toLocaleLowerCase().includes('comment') ? notification.text : '')).trim();
  const rawChanges = notification.changes ?? [];
  const lookups: ChangeLookups = {
    statuses: notification.changeLookups?.statuses ?? [],
    people: notification.changeLookups?.people ?? [],
    priorities: notification.changeLookups?.priorities ?? [],
    versions: notification.changeLookups?.versions ?? [],
    labels: notification.changeLookups?.labels ?? [],
  };
  const changes = rawChanges.map((change) => localizeJournalChange(change, lookups, translate));
  const fallback = notes || changes.length ? undefined : translate('notificationDetailsUnavailable');
  return { notes, changes, fallback };
}
