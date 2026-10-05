import type { BoardData, Issue } from '../../shared/types';

export interface OptimisticIssueMove {
  projectId: number;
  issue: Issue;
  phase: 'saving' | 'confirmed' | 'checking';
}

export type OptimisticIssueMoves = Readonly<Record<string, OptimisticIssueMove>>;

export function optimisticIssueMoveKey(projectId: number, issueId: number): string {
  return `${projectId}:${issueId}`;
}

/** Apply the requested status and/or Version membership without changing the other dimension. */
export function moveIssueOptimistically(issue: Issue, target: { statusId?: number; fixedVersionId?: number | null }): Issue {
  return {
    ...issue,
    statusId: target.statusId ?? issue.statusId,
    ...(Object.prototype.hasOwnProperty.call(target, 'fixedVersionId')
      ? { fixedVersionId: target.fixedVersionId ?? undefined }
      : {}),
  };
}

/** Reapply in-flight moves over any older poll/SSE snapshot, isolated by project. */
export function overlayOptimisticIssueMoves(board: BoardData | undefined, projectId: number, moves: OptimisticIssueMoves): BoardData | undefined {
  if (!board) return board;
  const projectMoves = Object.values(moves).filter(move => move.projectId === projectId && move.issue.projectId === projectId);
  if (projectMoves.length === 0) return board;
  const byId = new Map(projectMoves.map(move => [move.issue.id, move.issue]));
  const seen = new Set<number>();
  const issues = board.issues.map(issue => {
    if (issue.projectId !== projectId) return issue;
    const overlay = byId.get(issue.id);
    if (!overlay) return issue;
    seen.add(issue.id);
    return overlay;
  });
  for (const move of projectMoves) if (!seen.has(move.issue.id) && move.phase !== 'confirmed') issues.push(move.issue);
  return { ...board, issues };
}

export function mergeConfirmedIssue(board: BoardData | undefined, projectId: number, issue: Issue): BoardData | undefined {
  if (!board || issue.projectId !== projectId) return board;
  const index = board.issues.findIndex(candidate => candidate.id === issue.id);
  const issues = [...board.issues];
  if (index < 0) issues.push(issue);
  else issues[index] = issue;
  return { ...board, issues };
}

/** Reapply recently confirmed issue states over older board snapshots. */
export function overlayConfirmedIssueFloors(board: BoardData | undefined, floors: ReadonlyMap<string, Issue>, projectId?: number, missing?: ReadonlyMap<string, number>): BoardData | undefined {
  if (!board) return board;
  let result = board;
  for (const [key, issue] of floors) {
    if (key !== optimisticIssueMoveKey(issue.projectId, issue.id) || missing?.has(key) || (projectId !== undefined && issue.projectId !== projectId)) continue;
    const current = result.issues.find(candidate => candidate.id === issue.id && candidate.projectId === issue.projectId);
    if (!current) {
      result = mergeConfirmedIssue(result, issue.projectId, issue)!;
      continue;
    }
    const currentUpdatedOn = Date.parse(current.updatedOn);
    const confirmedUpdatedOn = Date.parse(issue.updatedOn);
    const sameMoveState = current.statusId === issue.statusId && current.fixedVersionId === issue.fixedVersionId;
    if (!Number.isFinite(currentUpdatedOn) || !Number.isFinite(confirmedUpdatedOn) || currentUpdatedOn < confirmedUpdatedOn || (currentUpdatedOn === confirmedUpdatedOn && !sameMoveState)) {
      result = mergeConfirmedIssue(result, issue.projectId, issue)!;
    }
  }
  return result;
}

export function boardHasIssueState(board: BoardData | undefined, issue: Issue): boolean {
  const current = board?.issues.find(candidate => candidate.id === issue.id && candidate.projectId === issue.projectId);
  if (!current || current.statusId !== issue.statusId || current.fixedVersionId !== issue.fixedVersionId) return false;
  const currentUpdatedOn = Date.parse(current.updatedOn);
  const expectedUpdatedOn = Date.parse(issue.updatedOn);
  // A delayed pre-command response can coincidentally have the requested state.
  return !Number.isFinite(currentUpdatedOn) || !Number.isFinite(expectedUpdatedOn) || currentUpdatedOn >= expectedUpdatedOn;
}

export function boardHasNewerIssueState(board: BoardData | undefined, issue: Issue): boolean {
  const current = board?.issues.find(candidate => candidate.id === issue.id && candidate.projectId === issue.projectId);
  if (!current) return false;
  const currentUpdatedOn = Date.parse(current.updatedOn);
  const expectedUpdatedOn = Date.parse(issue.updatedOn);
  return Number.isFinite(currentUpdatedOn) && Number.isFinite(expectedUpdatedOn) && currentUpdatedOn > expectedUpdatedOn;
}
