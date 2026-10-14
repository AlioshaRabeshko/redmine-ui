import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Issue, Version } from '../src/shared/types.js';
import { createConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/db/connection.js';
import { WorkspaceStore } from '../src/server/db/store.js';
import { demoIssues, demoMe, demoStatuses, demoVersions } from '../src/server/demo/fixtures.js';
import { CommandService } from '../src/server/commands/service.js';
import { RedmineRequestError } from '../src/server/redmine/transport.js';
import type { RedmineAdapter } from '../src/server/redmine/adapter.js';

type AdapterHarness = {
  adapter: RedmineAdapter;
  issues: Map<number, Issue>;
  updateCalls: Record<string, unknown>[];
  createIssueCalls: Record<string, unknown>[];
  failUpdate?: (issueId: number, fields: Record<string, unknown>) => Error | undefined;
};

describe('real Redmine command recovery with mocked adapter and SQLite', () => {
  let close: () => void;
  let store: WorkspaceStore;

  beforeEach(async () => {
    const database = openDatabase(':memory:');
    close = database.close;
    migrate(database.db, { migrationsFolder: 'drizzle' });
    store = new WorkspaceStore(database.db, 'demo:isolated');
    await store.initializeDemo();
  });

  afterEach(() => close());

  function service(adapter: RedmineAdapter): CommandService {
    return new CommandService(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid',
      REDMINE_API_TOKEN: 'test-only-token', REDMINE_WRITE_ENABLED: 'true' }), store, undefined, adapter);
  }

  function harness(issueIds: number[] = demoIssues.map(issue => issue.id)): AdapterHarness {
    const issues = new Map<number, Issue>(demoIssues.filter(issue => issueIds.includes(issue.id)).map(issue => [issue.id, {
      ...structuredClone(issue), primaryAssigneeId: issue.developerId, primaryAssigneeFieldId: 70,
      allowedStatusIds: demoStatuses.map(status => status.id),
    }]));
    const versions = new Map<number, Version>(demoVersions.map(version => [version.id, structuredClone(version)]));
    const updateCalls: Record<string, unknown>[] = [];
    const createIssueCalls: Record<string, unknown>[] = [];
    const state: AdapterHarness = { adapter: undefined as unknown as RedmineAdapter, issues, updateCalls, createIssueCalls };

    const adapter = {
      currentUser: async () => structuredClone(demoMe),
      issueDetail: async (id: number) => ({ issue: structuredClone(issues.get(id)!), journals: [], people: [] }),
      releaseIssues: async (versionId: number) => [...issues.values()].filter(issue => issue.fixedVersionId === versionId).map(issue => structuredClone(issue)),
      createIssue: async (fields: Record<string, unknown>) => {
        createIssueCalls.push(structuredClone(fields));
        const id = 9001;
        const issue: Issue = {
          id,
          projectId: Number(fields.project_id),
          subject: String(fields.subject),
          description: String(fields.description ?? ''),
          statusId: Number(fields.status_id),
          priorityId: Number(fields.priority_id),
          trackerId: Number(fields.tracker_id),
          trackerName: 'Feature',
          authorId: demoMe.id,
          ...(typeof fields.assigned_to_id === 'number' ? { assignedToId: fields.assigned_to_id } : {}),
          ...(typeof fields.fixed_version_id === 'number' ? { fixedVersionId: fields.fixed_version_id } : {}),
          branch: '', labels: [], watcherIds: [], createdOn: new Date().toISOString(), updatedOn: new Date().toISOString(),
          attachments: [], primaryAssigneeFieldId: 70, allowedStatusIds: demoStatuses.map(status => status.id),
        };
        issues.set(id, issue);
        return structuredClone(issue);
      },
      updateIssue: async (issueId: number, fields: Record<string, unknown>) => {
        updateCalls.push(structuredClone(fields));
        const failure = state.failUpdate?.(issueId, fields);
        if (failure) throw failure;
        const issue = issues.get(issueId)!;
        if (typeof fields.assigned_to_id === 'number') issue.assignedToId = fields.assigned_to_id;
        else if (fields.assigned_to_id === null) delete issue.assignedToId;
        if (typeof fields.status_id === 'number') issue.statusId = fields.status_id;
        if (typeof fields.fixed_version_id === 'number') issue.fixedVersionId = fields.fixed_version_id;
        else if (fields.fixed_version_id === null) delete issue.fixedVersionId;
        if (typeof fields.subject === 'string') issue.subject = fields.subject;
        if (typeof fields.description === 'string') issue.description = fields.description;
        if (Array.isArray(fields.custom_fields)) {
          for (const field of fields.custom_fields as { id: number; value: unknown }[]) {
            if (field.id === 50) issue.branch = String(field.value);
            if (field.id === 70) {
              issue.primaryAssigneeId = Number(field.value) || undefined;
              issue.developerId = issue.primaryAssigneeId;
            }
          }
        }
        issue.updatedOn = new Date().toISOString();
      },
      createVersion: async (projectId: number, fields: Record<string, unknown>) => {
        const version: Version = { id: 8001, projectId, name: String(fields.name), status: 'open' };
        versions.set(version.id, version);
        return structuredClone(version);
      },
      updateVersion: async (versionId: number, fields: Record<string, unknown>) => {
        const version = versions.get(versionId)!;
        if (typeof fields.status === 'string') version.status = fields.status as Version['status'];
      },
      versionDetail: async (versionId: number) => structuredClone(versions.get(versionId)!),
      writeFieldMetadata: async () => ({ branchFieldId: 50, primaryAssigneeFieldId: 70, sampleIssueId: 1001, labelFieldIds: [], labelOptions: [] }),
    } as unknown as RedmineAdapter;
    state.adapter = adapter;
    return state;
  }

  it('resumes moveIssue QA handoff from the durable checkpoint and writes only the final assignee', async () => {
    const fake = harness([1001]);
    let rejectQaOnce = true;
    fake.failUpdate = (_issueId, fields) => {
      if (fields.assigned_to_id === 3 && rejectQaOnce) {
        rejectQaOnce = false;
        return new RedmineRequestError('Redmine validation failed', 422);
      }
      return undefined;
    };
    const commands = service(fake.adapter);
    const command = { type: 'moveIssue' as const, issueId: 1001, operationId: 'qa-move-recovery',
      input: { statusId: 5, qaId: 3, developerId: 2 } };

    await expect(commands.execute(command)).rejects.toMatchObject({ code: 'REDMINE_VALIDATION', statusCode: 422 });
    expect(fake.updateCalls).toEqual([{ assigned_to_id: 1 }, { status_id: 5 }, { assigned_to_id: 3 }]);
    expect(fake.issues.get(1001)).toMatchObject({ statusId: 5, assignedToId: 1 });
    const saved = await store.getOperationRecord(command.operationId);
    expect(saved?.operation.status).toBe('failed');
    expect(saved?.context).toMatchObject({ workflowKind: 'handoffToQA', completedSteps: ['assign-self', 'status'] });

    fake.failUpdate = undefined;
    const resumed = await commands.execute({ type: 'moveIssue', issueId: 1001, operationId: command.operationId, input: {} });
    expect(resumed.operation.status).toBe('done');
    expect(fake.updateCalls.slice(3)).toEqual([{ assigned_to_id: 3 }]);
    expect(fake.issues.get(1001)).toMatchObject({ statusId: 5, assignedToId: 3 });
  });

  it('does not replay an ambiguous non-idempotent comment after restart-style retry', async () => {
    const fake = harness([1001]);
    fake.failUpdate = (_issueId, fields) => typeof fields.notes === 'string'
      ? new RedmineRequestError('Timed out waiting for Redmine', undefined, undefined, true)
      : undefined;
    const commands = service(fake.adapter);
    const command = { type: 'comment' as const, issueId: 1001, operationId: 'unknown-comment-recovery', input: { notes: 'One comment' } };

    const first = await commands.execute(command);
    expect(first.operation).toMatchObject({ status: 'blocked', errorCode: 'OUTCOME_UNKNOWN', retryable: false });
    const saved = await store.getOperationRecord(command.operationId);
    expect(saved?.context).toMatchObject({ outcomeUnknown: true, unknownStep: 'comment' });

    await expect(commands.execute({ ...command, input: {} })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', statusCode: 409 });
    expect(fake.updateCalls.filter(fields => typeof fields.notes === 'string')).toEqual([{ notes: 'One comment' }]);
  });

  it('blocks unverified journal edit/delete and unsupported likes before any Redmine request', async () => {
    const fake = harness([1001]);
    const issueDetail = vi.fn(fake.adapter.issueDetail);
    fake.adapter.issueDetail = issueDetail;
    await store.setValue('capabilities', { journalEditing: false, journalDeleting: false, journalLikes: false });
    const commands = service(fake.adapter);
    const edit = { journalId: 9002, expectedNotes: 'Original note', notes: 'Edited note' };
    const editResult = await commands.execute({ type: 'editJournal', issueId: 1001, input: edit });
    expect(editResult.operation).toMatchObject({ status: 'failed', errorCode: 'JOURNAL_EDIT_UNSUPPORTED' });
    const deleteResult = await commands.execute({ type: 'deleteJournal', issueId: 1001, input: { journalId: 9002, expectedNotes: 'Original note' } });
    expect(deleteResult.operation).toMatchObject({ status: 'failed', errorCode: 'JOURNAL_DELETE_UNSUPPORTED' });
    const likeResult = await commands.execute({ type: 'setJournalLike', issueId: 1001, input: { journalId: 9002, liked: true } });
    expect(likeResult.operation).toMatchObject({ status: 'failed', errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
  });

  it('retries a created issue from its persisted returned ID after a follow-up branch failure', async () => {
    const fake = harness([]);
    let rejectBranchOnce = true;
    fake.failUpdate = (_issueId, fields) => {
      if (Array.isArray(fields.custom_fields) && rejectBranchOnce) {
        rejectBranchOnce = false;
        return new RedmineRequestError('Redmine validation failed', 422);
      }
      return undefined;
    };
    const commands = service(fake.adapter);
    const command = { type: 'createIssue' as const, projectId: 10, operationId: 'create-followup-recovery',
      input: { subject: 'Persist returned issue ID' } };

    await expect(commands.execute(command)).rejects.toMatchObject({ code: 'REDMINE_VALIDATION', statusCode: 422 });
    expect(fake.createIssueCalls).toHaveLength(1);
    const saved = await store.getOperationRecord(command.operationId);
    expect(saved?.operation.issueId).toBe(9001);
    expect(saved?.context).toMatchObject({ createdIssueId: 9001, completedSteps: ['create'] });

    fake.failUpdate = undefined;
    const resumed = await commands.execute({ type: 'createIssue', operationId: command.operationId, issueId: 9001, input: {} });
    expect(resumed.operation.status).toBe('done');
    expect(resumed.issue).toMatchObject({ id: 9001, branch: '9001-persist-returned-issue-id' });
    expect(fake.createIssueCalls).toHaveLength(1);
    expect(fake.updateCalls).toEqual([
      { custom_fields: [{ id: 50, value: '9001-persist-returned-issue-id' }] },
      { custom_fields: [{ id: 50, value: '9001-persist-returned-issue-id' }] },
    ]);
  });
});
