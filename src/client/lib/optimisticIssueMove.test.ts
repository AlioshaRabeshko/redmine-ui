import { describe, expect, it } from 'vitest';
import { groupBoard } from '../../shared/domain';
import type { BoardData, Issue } from '../../shared/types';
import { demoIssues, demoStatuses, demoVersions } from '../../server/demo/fixtures';
import { boardHasIssueState, boardHasNewerIssueState, mergeConfirmedIssue, moveIssueOptimistically, optimisticIssueMoveKey, overlayConfirmedIssueFloors, overlayOptimisticIssueMoves } from './optimisticIssueMove';

const copy = (issue: Issue): Issue => structuredClone(issue);

describe('optimistic issue moves', () => {
  it('overlays a status change immediately and preserves existing Version membership', () => {
    const original = copy(demoIssues.find(issue => issue.id === 1001)!);
    const moved = moveIssueOptimistically(original, { statusId: 5, fixedVersionId: original.fixedVersionId });
    expect(moved).toMatchObject({ statusId: 5, fixedVersionId: 100 });
    expect(original.statusId).toBe(4);
  });

  it('changes Version membership without changing a non-Deploy status', () => {
    const issue = { ...copy(demoIssues.find(item => item.id === 1004)!), statusId: 2, fixedVersionId: undefined };
    const moved = moveIssueOptimistically(issue, { fixedVersionId: 100 });
    expect(moved).toMatchObject({ statusId: 2, fixedVersionId: 100 });
    expect(groupBoard([moved], demoStatuses, demoVersions).find(column => column.id === 'status:2')?.issues).toEqual([moved]);
  });

  it('classifies a Deploy issue with an active Version in its release lane', () => {
    const issue = { ...copy(demoIssues.find(item => item.id === 1004)!), statusId: 2, fixedVersionId: undefined };
    const moved = moveIssueOptimistically(issue, { statusId: 6, fixedVersionId: 100 });
    expect(groupBoard([moved], demoStatuses, demoVersions).find(column => column.id === 'version:100')?.issues).toEqual([moved]);
  });

  it('reapplies multiple issue overlays over stale snapshots without crossing project scopes', () => {
    const first = copy(demoIssues.find(issue => issue.id === 1001)!);
    const second = copy(demoIssues.find(issue => issue.id === 1004)!);
    const otherProject = copy(demoIssues.find(issue => issue.id === 2001)!);
    const board: BoardData = { issues: [first, second, otherProject], versions: demoVersions, members: [], labels: [], total: 3 };
    const moveA = moveIssueOptimistically(first, { statusId: 5 });
    const moveB = moveIssueOptimistically(second, { fixedVersionId: 100 });
    const overlays = {
      [optimisticIssueMoveKey(10, first.id)]: { projectId: 10, issue: moveA, phase: 'saving' as const },
      [optimisticIssueMoveKey(10, second.id)]: { projectId: 10, issue: moveB, phase: 'saving' as const },
    };
    const snapshot = { ...board, issues: [first, second, otherProject] };
    const visible = overlayOptimisticIssueMoves(snapshot, 10, overlays)!;
    expect(visible.issues.find(issue => issue.id === first.id)?.statusId).toBe(5);
    expect(visible.issues.find(issue => issue.id === second.id)?.fixedVersionId).toBe(100);
    expect(visible.issues.find(issue => issue.id === otherProject.id)).toBe(otherProject);
    expect(overlayOptimisticIssueMoves(snapshot, 20, overlays)?.issues).toEqual(snapshot.issues);
  });

  it('keeps confirmed remote values in cache and adds the issue if a stale board omitted it', () => {
    const confirmed = { ...copy(demoIssues.find(issue => issue.id === 1001)!), statusId: 5, updatedOn: '2026-10-05T12:00:00.000Z' };
    const board: BoardData = { issues: [], versions: demoVersions, members: [], labels: [], total: 0 };
    expect(mergeConfirmedIssue(board, confirmed.projectId, confirmed)?.issues).toEqual([confirmed]);
    expect(mergeConfirmedIssue(board, 20, confirmed)).toBe(board);
  });

  it('retains its fence for an older response with matching status and Version', () => {
    const confirmed = { ...copy(demoIssues.find(issue => issue.id === 1001)!), statusId: 5, updatedOn: '2026-10-05T12:00:00.000Z' };
    const delayed = { ...confirmed, updatedOn: '2026-10-05T11:59:59.000Z' };
    const board: BoardData = { issues: [delayed], versions: demoVersions, members: [], labels: [], total: 1 };
    expect(boardHasIssueState(board, confirmed)).toBe(false);
    expect(boardHasIssueState({ ...board, issues: [confirmed] }, confirmed)).toBe(true);
  });

  it('shields later delayed board responses from a confirmed issue floor', () => {
    const confirmed = { ...copy(demoIssues.find(issue => issue.id === 1001)!), statusId: 5, updatedOn: '2026-10-05T12:00:00.000Z' };
    const delayed = { ...confirmed, statusId: 4, updatedOn: '2026-10-05T11:59:59.000Z' };
    const board: BoardData = { issues: [delayed], versions: demoVersions, members: [], labels: [], total: 1 };
    const result = overlayConfirmedIssueFloors(board, new Map([[optimisticIssueMoveKey(confirmed.projectId, confirmed.id), confirmed]]));
    expect(result?.issues[0]).toEqual(confirmed);
  });

  it('does not resurrect a confirmed issue after a verified missing or inaccessible read', () => {
    const confirmed = { ...copy(demoIssues.find(issue => issue.id === 1001)!), statusId: 5, updatedOn: '2026-10-05T12:00:00.000Z' };
    const board: BoardData = { issues: [], versions: demoVersions, members: [], labels: [], total: 0 };
    const key = optimisticIssueMoveKey(confirmed.projectId, confirmed.id);
    expect(overlayConfirmedIssueFloors(board, new Map([[key, confirmed]]), confirmed.projectId, new Map([[key, Date.parse(confirmed.updatedOn)]]))?.issues).toEqual([]);
  });

  it('lets a fresher remote update supersede a confirmed floor', () => {
    const confirmed = { ...copy(demoIssues.find(issue => issue.id === 1001)!), statusId: 5, updatedOn: '2026-10-05T12:00:00.000Z' };
    const laterRemote = { ...confirmed, statusId: 6, updatedOn: '2026-10-05T12:00:01.000Z' };
    const board: BoardData = { issues: [laterRemote], versions: demoVersions, members: [], labels: [], total: 1 };
    expect(boardHasNewerIssueState(board, confirmed)).toBe(true);
    expect(overlayConfirmedIssueFloors(board, new Map([[optimisticIssueMoveKey(confirmed.projectId, confirmed.id), confirmed]]))?.issues[0]).toEqual(laterRemote);
  });
});
