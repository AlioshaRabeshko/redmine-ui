import type { AppSettings, Filters, Issue, Priority, Status, StatusKey, Version, View } from './types.js';

export const primaryStatusKeys: StatusKey[] = ['suspended', 'todo', 'progress', 'review', 'qa', 'deploy'];

/** Unicode is retained; we do not silently transliterate user-entered titles. */
export function branchForIssue(id: number, title: string): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid issue ID');
  const slug = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'issue';
  return `${id}-${slug}`;
}

export function filterIssues(issues: Issue[], statuses: Status[], view: View, meId: number, filters: Filters = {}): Issue[] {
  const statusById = new Map(statuses.map(s => [s.id, s]));
  const query = filters.search?.trim().toLocaleLowerCase();
  return issues.filter(issue => {
    const status = statusById.get(issue.statusId);
    const explicitlyFiltered = Boolean(filters.statusIds?.length);
    if (!filters.includeClosed && !explicitlyFiltered && (status?.isClosed || status?.key === 'done' || status?.key === 'rejected')) return false;
    if (view === 'backlog' && status?.key !== 'backlog') return false;
    if (view !== 'backlog' && !explicitlyFiltered && status?.key === 'backlog') return false;
    if (view === 'mine' && issue.assignedToId !== meId) return false;
    if (view === 'watching' && !issue.watcherIds.includes(meId)) return false;
    if (query && !`${issue.id} ${issue.subject} ${issue.description} ${issue.branch}`.toLocaleLowerCase().includes(query)) return false;
    if (filters.assigneeId !== undefined && issue.assignedToId !== filters.assigneeId) return false;
    if (filters.label && !issue.labels.includes(filters.label)) return false;
    if (filters.versionId !== undefined && issue.fixedVersionId !== filters.versionId) return false;
    if (filters.statusIds?.length && !filters.statusIds.includes(issue.statusId)) return false;
    if (filters.priorityIds?.length && !filters.priorityIds.includes(issue.priorityId)) return false;
    return true;
  });
}

export function sortIssues(issues: Issue[], priorities: Priority[], sort: AppSettings['sort']): Issue[] {
  const ranks = new Map(priorities.map(p => [p.id, p.rank]));
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => {
    let diff: number;
    switch (sort.field) {
      case 'priority': diff = (ranks.get(a.priorityId) ?? 0) - (ranks.get(b.priorityId) ?? 0); break;
      case 'updated': diff = a.updatedOn.localeCompare(b.updatedOn); break;
      case 'created': diff = a.createdOn.localeCompare(b.createdOn); break;
      case 'subject': diff = a.subject.localeCompare(b.subject); break;
      default: diff = a.id - b.id;
    }
    return sign * diff || a.id - b.id;
  });
}

export interface BoardColumn { id: string; name: string; status?: Status; version?: Version; issues: Issue[] }

/** Versions only affect presentation; do not derive transition commands from this key. */
export function issueColumnId(issue: Issue, versions: Version[]): string {
  const version = versions.find(v => v.id === issue.fixedVersionId && v.projectId === issue.projectId && v.status !== 'closed');
  return version ? `version:${version.id}` : `status:${issue.statusId}`;
}

export function groupBoard(issues: Issue[], statuses: Status[], versions: Version[], view: View = 'all'): BoardColumn[] {
  const baseKeys = view === 'backlog' ? ['backlog'] : primaryStatusKeys;
  const columns: BoardColumn[] = baseKeys.flatMap(key => statuses.filter(s => s.key === key).map(status => ({
    id: `status:${status.id}`, name: status.name, status, issues: [] as Issue[],
  })));
  const activeVersions = versions.filter(v => v.status !== 'closed').sort((a, b) => {
    const aNext = a.name.trim().toUpperCase() === 'NEXT';
    const bNext = b.name.trim().toUpperCase() === 'NEXT';
    return Number(bNext) - Number(aNext) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id - b.id;
  });
  columns.push(...activeVersions.map(version => ({ id: `version:${version.id}`, name: version.name, version, issues: [] as Issue[] })));
  for (const issue of issues) {
    const id = issueColumnId(issue, activeVersions);
    let column = columns.find(c => c.id === id);
    if (!column) {
      const status = statuses.find(s => s.id === issue.statusId);
      column = { id, name: status?.name ?? `#${issue.statusId}`, status, issues: [] };
      columns.push(column);
    }
    column.issues.push(issue);
  }
  return columns;
}

export function releaseReadiness(issues: Issue[], statuses: Status[]): { ready: boolean; pending: Issue[]; completed: Issue[] } {
  const statusById = new Map(statuses.map(s => [s.id, s]));
  const completed = issues.filter(i => { const s = statusById.get(i.statusId); return s?.key === 'done' && s.isClosed; });
  const pending = issues.filter(i => { const s = statusById.get(i.statusId); return !(s?.key === 'done' && s.isClosed) && s?.key !== 'deploy'; });
  return { ready: pending.length === 0, pending, completed };
}
