import type { BoardColumn } from '../../../shared/domain';
import type { Issue } from '../../../shared/types';

/** A status column is a drop target only when Redmine supplied its allowed transition. */
export function canDropIssueOnColumn(issue: Issue, column: BoardColumn): boolean {
  if (column.version) return true;
  return Boolean(column.status && issue.allowedStatusIds?.includes(column.status.id));
}

export function toggleCollapsedColumn(columnIds: readonly string[], columnId: string): string[] {
  const current = new Set(columnIds);
  if (current.has(columnId)) current.delete(columnId);
  else current.add(columnId);
  return [...current];
}
