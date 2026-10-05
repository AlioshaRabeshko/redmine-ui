import type { ActivityKind, ActivityVisibility, Journal, LabelOption, Person, Priority, Status, Version } from '../../shared/types';

export interface VisibleJournal {
  journal: Journal;
  showComment: boolean;
  changes: Journal['changes'];
  forcedByPermalink: boolean;
}

export interface ChangeLookups {
  statuses: Status[];
  people: Person[];
  priorities: Priority[];
  versions: Version[];
  labels: LabelOption[];
}

export interface LocalizedChange {
  field: string;
  oldValue: string;
  newValue: string;
}

export function activityKindForField(field: string): ActivityKind {
  const normalized = field.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (normalized === 'status' || normalized === 'statusid') return 'status';
  if (['assignee', 'assignedto', 'assignedtoid', 'assigneduser', 'assigneduserid'].includes(normalized)) return 'assignee';
  if (normalized === 'label' || normalized === 'labels' || normalized === 'tag' || normalized === 'tags' || normalized.includes('labelsfield')) return 'labels';
  return 'field';
}

/** Filter notes and each field change independently. A permalink may reveal just its target without changing settings. */
export function visibleJournals(
  journals: Journal[],
  visibility: ActivityVisibility,
  initialJournalId?: number,
): VisibleJournal[] {
  return [...journals].sort(compareJournalsNewestFirst).flatMap((journal) => {
    const isPermalinkTarget = journal.id === initialJournalId;
    const ordinaryComment = Boolean(journal.notes.trim()) && visibility.comment;
    const ordinaryChanges = journal.changes.filter((change) => visibility[activityKindForField(change.field)]);
    const forcedByPermalink = isPermalinkTarget && (!ordinaryComment && Boolean(journal.notes.trim()) || ordinaryChanges.length !== journal.changes.length);
    const showComment = Boolean(journal.notes.trim()) && (visibility.comment || forcedByPermalink);
    const changes = forcedByPermalink ? journal.changes : ordinaryChanges;
    if (!showComment && changes.length === 0 && !forcedByPermalink) return [];
    return [{ journal, showComment, changes, forcedByPermalink }];
  });
}

function compareJournalsNewestFirst(a: Journal, b: Journal): number {
  const aTime = Date.parse(a.createdOn);
  const bTime = Date.parse(b.createdOn);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if ((!Number.isFinite(aTime) || !Number.isFinite(bTime)) && a.createdOn !== b.createdOn) return b.createdOn.localeCompare(a.createdOn);
  return b.id - a.id;
}

export function localizeJournalChange(
  change: Journal['changes'][number],
  lookups: ChangeLookups,
  translate: (key: string) => string,
): LocalizedChange {
  const kind = activityKindForField(change.field);
  const normalized = change.field.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const field = kind === 'status' ? translate('status')
    : kind === 'assignee' ? translate('assignee')
      : kind === 'labels' ? translate('labels')
        : normalized === 'priority' || normalized === 'priorityid' ? translate('priorityField')
          : normalized === 'fixedversion' || normalized === 'fixedversionid' || normalized === 'version' || normalized === 'versionid' ? translate('release')
            : change.field;
  const valueKind = kind === 'status' ? 'status'
    : kind === 'assignee' ? 'person'
      : kind === 'labels' ? 'label'
        : normalized === 'priority' || normalized === 'priorityid' ? 'priority'
          : normalized === 'fixedversion' || normalized === 'fixedversionid' || normalized === 'version' || normalized === 'versionid' ? 'version'
            : undefined;
  return {
    field,
    oldValue: formatJournalValue(change.oldValue, valueKind, lookups, translate),
    newValue: formatJournalValue(change.newValue, valueKind, lookups, translate),
  };
}

function formatJournalValue(
  value: string | undefined,
  kind: 'status' | 'person' | 'label' | 'priority' | 'version' | undefined,
  lookups: ChangeLookups,
  translate: (key: string) => string,
): string {
  if (value === undefined || value === '') {
    return kind === 'person' ? translate('noAssignee') : translate('cleared');
  }
  if (!kind) return value;
  if (kind === 'label') {
    return value.split(/[\n,;]+/).map((part) => part.trim()).filter(Boolean)
      .map((part) => lookupName(part, lookups.labels, (entry) => entry.id, (entry) => entry.name, translate)).join(', ');
  }
  const items = kind === 'status' ? lookups.statuses
    : kind === 'person' ? lookups.people
      : kind === 'priority' ? lookups.priorities
        : lookups.versions;
  const getId = (item: Status | Person | Priority | Version) => String(item.id);
  const getName = (item: Status | Person | Priority | Version) => item.name;
  return lookupName(value, items, getId, getName, translate);
}

function lookupName<T>(
  value: string,
  items: T[],
  getId: (item: T) => string,
  getName: (item: T) => string,
  translate: (key: string) => string,
): string {
  const names = new Set(items.filter((candidate) => getId(candidate) === value).map(getName));
  // Numeric custom-field options can collide across Labels/Tags catalogs.
  // The adapter normally resolves them with field ID; never guess an unresolved ambiguous value here.
  if (names.size === 1) return [...names][0]!;
  return /^\d+$/.test(value) ? `${translate('unknown')} (#${value})` : value;
}
