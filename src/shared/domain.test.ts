import { describe, expect, it } from 'vitest';
import { branchForIssue, filterIssues, groupBoard, issueColumnId, releaseReadiness, sortIssues, toggleAssignedToMe } from './domain.js';
import type { Issue, Status, Version } from './types.js';

const statuses: Status[] = [
  { id: 1, name: 'To Do', key: 'todo', isClosed: false },
  { id: 2, name: 'Deploy', key: 'deploy', isClosed: true },
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
  it('puts only Deploy members of active versions in release lanes', () => {
    const reviewMember = issue({ id: 1, statusId: 1, fixedVersionId: 1 });
    const deployedMember = issue({ id: 2, statusId: 2, fixedVersionId: 1 });
    expect(issueColumnId(reviewMember, versions, statuses)).toBe('status:1');
    expect(issueColumnId(deployedMember, versions, statuses)).toBe('version:1');
    const columns = groupBoard([reviewMember, deployedMember], statuses, versions);
    expect(columns.find(c => c.id === 'status:1')?.issues.map(i => i.id)).toEqual([1]);
    expect(columns.find(c => c.id === 'version:1')?.issues.map(i => i.id)).toEqual([2]);
  });
  it('pins active-version status members before ordinary cards while keeping group order', () => {
    const issues = [
      issue({ id: 1, statusId: 1, fixedVersionId: 1 }),
      issue({ id: 2, statusId: 1 }),
      issue({ id: 3, statusId: 1, fixedVersionId: 1 }),
      issue({ id: 4, statusId: 1 }),
    ];
    const todo = groupBoard(issues, statuses, versions).find(c => c.id === 'status:1')!;
    expect(todo.issues.map(i => i.id)).toEqual([1, 3, 2, 4]);
  });
  it('does not lose unfinished work with closed, missing or foreign versions/statuses', () => {
    expect(issueColumnId(issue({ fixedVersionId: 2 }), versions)).toBe('status:1');
    expect(issueColumnId(issue({ fixedVersionId: 3 }), versions)).toBe('status:1');
    const columns = groupBoard([issue({ statusId: 99 })], statuses, versions);
    expect(columns.flatMap(c => c.issues)).toHaveLength(1);
    expect(columns.some(c => c.id === 'version:2')).toBe(false);
  });
  it('keeps Deploy visible when it is marked closed, hides finished/backlog by default', () => {
    const tasks = [issue(), issue({ id: 2, statusId: 2 }), issue({ id: 3, statusId: 3 }), issue({ id: 4, statusId: 5 })];
    expect(filterIssues(tasks, statuses, 'all', 1).map(i => i.id)).toEqual([1, 2]);
    expect(filterIssues(tasks, statuses, 'all', 1, { statusIds: [3] }).map(i => i.id)).toEqual([3]);
    expect(filterIssues(tasks, statuses, 'backlog', 1).map(i => i.id)).toEqual([4]);
  });
  it('searches labels and the people connected to an issue', () => {
    const tasks = [
      issue({ id: 1, labels: ['accessibility'], assignedToId: 2 }),
      issue({ id: 2, labels: ['backend'], assignedToId: 3 }),
    ];
    const people = [{ id: 2, name: 'Example Person A QA' }, { id: 3, name: 'Maksym Developer' }];
    expect(filterIssues(tasks, statuses, 'all', 1, { search: 'accessibility' }, people).map(i => i.id)).toEqual([1]);
    expect(filterIssues(tasks, statuses, 'all', 1, { search: 'maksym' }, people).map(i => i.id)).toEqual([2]);
  });
  it('matches any selected label and keeps the legacy single-label field readable', () => {
    const tasks = [issue({ id: 1, labels: ['frontend'] }), issue({ id: 2, labels: ['support'] }), issue({ id: 3, labels: ['docs'] })];
    expect(filterIssues(tasks, statuses, 'all', 1, { labels: ['frontend', 'support'] }).map(i => i.id)).toEqual([1, 2]);
    expect(filterIssues(tasks, statuses, 'all', 1, { label: 'docs' }).map(i => i.id)).toEqual([3]);
  });
  it('toggles assigned-to-me without clearing other filters', () => {
    const current = { search: 'dialog', statusIds: [2], labels: ['ux'], assigneeId: 9 };
    const enabled = toggleAssignedToMe(current);
    expect(enabled).toEqual({ ...current, assignedToMe: true });
    expect(toggleAssignedToMe(enabled)).toEqual(current);
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
