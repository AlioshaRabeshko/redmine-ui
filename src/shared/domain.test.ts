import { describe, expect, it } from 'vitest';
import { branchForIssue, filterIssues, groupBoard, issueColumnId, releaseReadiness, sortIssues } from './domain.js';
import type { Issue, Status, Version } from './types.js';

const statuses: Status[] = [
  { id: 1, name: 'To Do', key: 'todo', isClosed: false },
  { id: 2, name: 'Deploy', key: 'deploy', isClosed: false },
  { id: 3, name: 'Done', key: 'done', isClosed: true },
  { id: 4, name: 'Rejected', key: 'rejected', isClosed: true },
  { id: 5, name: 'Backlog', key: 'backlog', isClosed: false },
];
const versions: Version[] = [
  { id: 1, projectId: 1, name: 'NEXT', status: 'open' },
  { id: 2, projectId: 1, name: 'Past', status: 'closed' },
  { id: 3, projectId: 2, name: 'Other', status: 'open' },
];
const issue = (patch: Partial<Issue> = {}): Issue => ({
  id: 1, projectId: 1, subject: 'Task', description: '', statusId: 1, priorityId: 1,
  trackerId: 1, trackerName: 'Task', authorId: 1, branch: '', labels: [], watcherIds: [],
  createdOn: '2026-10-01', updatedOn: '2026-10-01', attachments: [], ...patch,
});

describe('board and release rules', () => {
  it('retains actual status while version membership owns the visible lane', () => {
    const task = issue({ fixedVersionId: 1 });
    expect(issueColumnId(task, versions)).toBe('version:1');
    expect(groupBoard([task], statuses, versions).find(c => c.id === 'version:1')?.issues[0].statusId).toBe(1);
  });
  it('does not lose unfinished work with closed, missing or foreign versions/statuses', () => {
    expect(issueColumnId(issue({ fixedVersionId: 2 }), versions)).toBe('status:1');
    expect(issueColumnId(issue({ fixedVersionId: 3 }), versions)).toBe('status:1');
    const columns = groupBoard([issue({ statusId: 99 })], statuses, versions);
    expect(columns.flatMap(c => c.issues)).toHaveLength(1);
    expect(columns.some(c => c.id === 'version:2')).toBe(false);
  });
  it('default hides finished/backlog but explicit status filters can show them', () => {
    const tasks = [issue(), issue({ id: 2, statusId: 3 }), issue({ id: 3, statusId: 5 })];
    expect(filterIssues(tasks, statuses, 'all', 1)).toHaveLength(1);
    expect(filterIssues(tasks, statuses, 'all', 1, { statusIds: [3] }).map(i => i.id)).toEqual([2]);
    expect(filterIssues(tasks, statuses, 'backlog', 1).map(i => i.id)).toEqual([3]);
  });
  it('sorts by priority rank, not raw Redmine priority ID', () => {
    const tasks = [issue({ id: 2, priorityId: 100 }), issue({ id: 1, priorityId: 4 })];
    expect(sortIssues(tasks, [{ id: 100, name: 'Low', rank: 1 }, { id: 4, name: 'High', rank: 5 }], { field: 'priority', direction: 'desc' }).map(i => i.id)).toEqual([1, 2]);
  });
  it('accepts Deploy and previously Done, but never equates Rejected to completion', () => {
    expect(releaseReadiness([issue({ statusId: 2 }), issue({ statusId: 3 })], statuses).ready).toBe(true);
    expect(releaseReadiness([issue({ statusId: 4 })], statuses).ready).toBe(false);
    expect(releaseReadiness([issue({ statusId: 3 })], statuses.map(s => ({ ...s, isClosed: false }))).ready).toBe(false);
  });
});

describe('branch names', () => {
  it('uses real ID, Unicode title and safe hyphenated Git ref components', () => {
    expect(branchForIssue(4243, ' Fix Grid Export ')).toBe('4243-fix-grid-export');
    expect(branchForIssue(4243, 'Оновити пошук')).toBe('4243-оновити-пошук');
    expect(branchForIssue(42, '.. ~a^b:c?d*e[f]\\g@{h/i.lock')).toBe('42-a-b-c-d-e-f-g-h-i-lock');
    expect(branchForIssue(1, ' ')).toBe('1-issue');
    expect(() => branchForIssue(0, 'title')).toThrow();
  });
});
