import type { ActivityKind, AppSettings, Issue, Journal, LabelOption, Notification, Person, Priority, Status, Subscription, Version } from '../shared/types.js';

/** Internal sync cursor; never exposed through the client settings contract. */
export function issueCreatedSubscriptionCursorKey(projectId: number): string {
  return `issue-created-subscription:${projectId}`;
}

export interface NotificationProjectionData {
  issues: Issue[];
  journalsByIssue: Map<number, Journal[]>;
  statuses: Status[];
  people: Person[];
  priorities: Priority[];
  versions: Version[];
  labelOptions: Record<string, LabelOption[]>;
  settings: AppSettings;
}

/** Project locally stored events through the current event mask without mutating their read/archive state. */
export function projectNotification(notification: Notification, data: NotificationProjectionData): Notification | undefined {
  const issue = data.issues.find((item) => item.id === notification.issueId);
  if (notification.kind === 'issue_created') {
    const subscription = data.settings.subscriptions[String(notification.projectId)];
    if (!subscription?.enabled || !subscription.events.includes('issue_created')) return undefined;
    return { ...notification, ...(issue?.subject ? { issueSubject: issue.subject, text: issue.subject } : {}) };
  }
  const journalId = notification.journalId ?? journalIdFromNotificationId(notification.id);
  const sourceJournal = data.journalsByIssue.get(notification.issueId)?.find((item) => item.id === journalId);
  const rawNotes = sourceJournal?.notes ?? notification.notes ?? (notification.kind === 'comment' ? notification.text : '');
  const rawChanges = sourceJournal?.changes ?? notification.changes ?? [];
  const sourceKinds = sourceJournal ? activityKindsForJournal(sourceJournal.notes, sourceJournal.changes)
    : notification.eventKinds?.length ? notification.eventKinds : inferKinds(rawNotes, rawChanges, notification.kind);
  const configuredEvents = data.settings.subscriptions[String(notification.projectId)]?.events ?? ['comment'];
  const enabledKinds = new Set<ActivityKind>(configuredEvents.filter(isActivityKind));
  const visibleKinds = sourceKinds.filter((kind) => enabledKinds.has(kind));
  if (visibleKinds.length === 0) return undefined;

  const notes = visibleKinds.includes('comment') && rawNotes.trim() ? rawNotes : '';
  const changes = rawChanges.filter((change) => visibleKinds.includes(activityKindForField(change.field)));
  const hasUncachedDetails = !sourceJournal && !notification.notes && notification.changes === undefined && !notes && changes.length === 0;
  if (!notes && changes.length === 0 && !hasUncachedDetails) return undefined;

  const lookups = buildChangeLookups(changes, notification.projectId, data);
  const visibleKind = preferredKind(visibleKinds);
  return {
    ...notification,
    ...(issue?.subject ? { issueSubject: issue.subject } : {}),
    kind: visibleKind,
    text: notes,
    ...(notes ? { notes } : { notes: undefined }),
    changes,
    eventKinds: visibleKinds,
    changeLookups: lookups,
    detailsUnavailable: hasUncachedDetails || undefined,
  };
}

export function projectNotifications(notifications: Notification[], data: NotificationProjectionData): Notification[] {
  return notifications.flatMap((notification) => {
    const projected = projectNotification(notification, data);
    return projected ? [projected] : [];
  });
}

export function activityKindsForJournal(notes: string, changes: Journal['changes']): ActivityKind[] {
  const kinds = new Set<ActivityKind>();
  if (notes.trim()) kinds.add('comment');
  for (const change of changes) kinds.add(activityKindForField(change.field));
  return [...kinds];
}

export function resolveNotificationEligibility(
  kinds: ActivityKind[], subscription: Subscription | undefined, assignedToMe: boolean,
): { eligible: boolean; visibleKinds: ActivityKind[] } {
  const configuredEvents = subscription?.events ?? ['comment'];
  const visibleKinds = kinds.filter((kind) => configuredEvents.includes(kind));
  const subscribed = Boolean(subscription?.enabled && visibleKinds.length > 0);
  return { eligible: subscribed || assignedToMe, visibleKinds };
}

function inferKinds(notes: string, changes: Journal['changes'], fallbackKind: string): ActivityKind[] {
  const kinds = new Set<ActivityKind>();
  if (notes.trim()) kinds.add('comment');
  for (const change of changes) kinds.add(activityKindForField(change.field));
  if (!kinds.size && isActivityKind(fallbackKind)) kinds.add(fallbackKind);
  return [...kinds];
}

function isActivityKind(value: string): value is ActivityKind {
  return value === 'comment' || value === 'status' || value === 'assignee' || value === 'labels' || value === 'field';
}

function preferredKind(kinds: ActivityKind[]): ActivityKind {
  for (const preferred of ['comment', 'status', 'assignee', 'labels', 'field'] as const) {
    if (kinds.includes(preferred)) return preferred;
  }
  return 'field';
}

function journalIdFromNotificationId(id: string): number | undefined {
  const match = id.match(/^journal:(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function activityKindForField(field: string): ActivityKind {
  const normalized = field.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (normalized === 'status' || normalized === 'statusid') return 'status';
  if (['assignee', 'assignedto', 'assignedtoid', 'assigneduser', 'assigneduserid'].includes(normalized)) return 'assignee';
  if (normalized === 'label' || normalized === 'labels' || normalized === 'tag' || normalized === 'tags' || normalized.includes('labelsfield')) return 'labels';
  return 'field';
}

function buildChangeLookups(changes: Journal['changes'], projectId: number, data: NotificationProjectionData): NonNullable<Notification['changeLookups']> {
  const values = new Set(changes.flatMap((change) => [change.oldValue, change.newValue])
    .filter((value): value is string => value !== undefined && value !== '')
    .flatMap((value) => value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean)));
  const ids = new Set([...values].filter((value) => /^\d+$/.test(value)));
  const labels = data.labelOptions[String(projectId)] ?? [];
  const labelIds = new Set(values);
  const peopleIds = new Set([...ids].map(Number));
  const versionsByProject = data.versions.filter((version) => version.projectId === projectId);
  return {
    statuses: data.statuses.filter((status) => ids.has(String(status.id))),
    people: data.people.filter((person) => peopleIds.has(person.id)),
    priorities: data.priorities.filter((priority) => ids.has(String(priority.id))),
    versions: versionsByProject.filter((version) => ids.has(String(version.id))),
    labels: labels.filter((option) => labelIds.has(option.id)),
  };
}
