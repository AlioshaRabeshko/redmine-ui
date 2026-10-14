import { describe, expect, it } from 'vitest';
import type { BoardColumn } from '../../../shared/domain';
import type { Issue, Status, Version } from '../../../shared/types';
import { canDropIssueOnColumn, toggleCollapsedColumn } from './boardInteractions';

const status: Status = { id: 4, name: 'Review', key: 'review', isClosed: false };
const version: Version = { id: 8, projectId: 2, name: 'Sprint 8', status: 'open' };
const issue: Issue = {
  id: 12, projectId: 2, subject: 'Allowed transition', description: '', statusId: 1, priorityId: 2,
  trackerId: 1, trackerName: 'Task', authorId: 1, branch: '', labels: [], watcherIds: [],
  createdOn: '2026-10-01', updatedOn: '2026-10-01', attachments: [], allowedStatusIds: [3, 4],
};
const lane = (patch: Partial<BoardColumn>): BoardColumn => ({ id: 'status:4', name: 'Review', status, issues: [], ...patch });

describe('board drag targets', () => {
  it('only enables status lanes present in the issue allowed transitions', () => {
    expect(canDropIssueOnColumn(issue, lane({}))).toBe(true);
    expect(canDropIssueOnColumn(issue, lane({ status: { ...status, id: 9 } }))).toBe(false);
  });

  it('keeps deleted or unknown status lanes non-droppable', () => {
    expect(canDropIssueOnColumn(issue, lane({ id: 'status:unknown', status: undefined }))).toBe(false);
    expect(canDropIssueOnColumn({ ...issue, allowedStatusIds: undefined }, lane({}))).toBe(false);
  });

  it('keeps roadmap membership drops available without changing status', () => {
    expect(canDropIssueOnColumn({ ...issue, allowedStatusIds: undefined }, lane({ id: `version:${version.id}`, name: version.name, status: undefined, version }))).toBe(true);
  });
});

describe('collapsed board columns', () => {
  it('toggles only the requested project column and returns unique IDs', () => {
    expect(toggleCollapsedColumn(['status:4', 'version:8'], 'status:4')).toEqual(['version:8']);
    expect(toggleCollapsedColumn(['status:4', 'status:4'], 'version:8')).toEqual(['status:4', 'version:8']);
  });
});
