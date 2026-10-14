import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../db/connection.js';
import { WorkspaceStore } from '../db/store.js';
import { createConfig } from '../config.js';
import { RedmineRequestError } from '../redmine/transport.js';
import type { RedmineAdapter } from '../redmine/adapter.js';
import type { Issue, Version } from '../../shared/types.js';
import { demoIssues, demoStatuses, demoVersions } from '../demo/fixtures.js';
import { CommandService } from './service.js';
import { RealCommandExecutor } from './real-executor.js';

type AdapterHarness = {
  adapter: RedmineAdapter;
  issues: Map<number, Issue>;
  versions: Map<number, Version>;
  updateCalls: Record<string, unknown>[];
  createIssue: ReturnType<typeof vi.fn>;
  createVersion: ReturnType<typeof vi.fn>;
  updateVersion: ReturnType<typeof vi.fn>;
  issueDetail: ReturnType<typeof vi.fn>;
  failUpdate?: (issueId: number, fields: Record<string, unknown>, call: number) => boolean | 'unknown';
};

describe('real Redmine command executor with mocked adapter', () => {
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

  function service(adapter: RedmineAdapter, enabled = true): CommandService {
    return new CommandService(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid',
      REDMINE_API_TOKEN: 'test-only-token', REDMINE_WRITE_ENABLED: enabled ? 'true' : 'false' }), store, undefined, adapter);
  }

  function harness(issueIds: number[] = demoIssues.map(issue => issue.id)): AdapterHarness {
    const issues = new Map<number, Issue>(demoIssues.filter(issue => issueIds.includes(issue.id)).map(issue => [issue.id, {
      ...structuredClone(issue), primaryAssigneeId: issue.developerId, primaryAssigneeFieldId: 70,
      allowedStatusIds: demoStatuses.map(status => status.id),
    }]));
    const versions = new Map(demoVersions.map(version => [version.id, structuredClone(version)]));
    const updateCalls: Record<string, unknown>[] = [];
    let updateAttempt = 0;
    const result: AdapterHarness = {
      issues, versions, updateCalls,
      createIssue: vi.fn(async (fields: Record<string, unknown>) => {
        const id = 9001;
        const issue: Issue = { id, projectId: Number(fields.project_id), subject: String(fields.subject), description: String(fields.description ?? ''),
          statusId: Number(fields.status_id), priorityId: Number(fields.priority_id), trackerId: Number(fields.tracker_id), trackerName: 'Feature',
          authorId: 1, branch: '', labels: [], watcherIds: [], createdOn: new Date().toISOString(), updatedOn: new Date().toISOString(), attachments: [],
          primaryAssigneeFieldId: 70, allowedStatusIds: demoStatuses.map(status => status.id) };
        issues.set(id, issue);
        return structuredClone(issue);
      }),
      createVersion: vi.fn(async (projectId: number, fields: Record<string, unknown>) => {
        const version: Version = { id: 8001, projectId, name: String(fields.name), status: 'open',
          ...(typeof fields.description === 'string' ? { description: fields.description } : {}) };
        versions.set(version.id, version);
        return structuredClone(version);
      }),
      updateVersion: vi.fn(async (versionId: number, fields: Record<string, unknown>) => {
        const version = versions.get(versionId)!;
        if (typeof fields.status === 'string') version.status = fields.status as Version['status'];
        if (typeof fields.name === 'string') version.name = fields.name;
        if (fields.due_date === null) delete version.dueDate;
        else if (typeof fields.due_date === 'string') version.dueDate = fields.due_date;
        if (typeof fields.description === 'string') version.description = fields.description;
      }),
      issueDetail: vi.fn(async (issueId: number) => ({ issue: structuredClone(issues.get(issueId)!), journals: [], people: [] })),
      failUpdate: undefined,
      adapter: undefined as unknown as RedmineAdapter,
    };
    result.adapter = {
      currentUser: vi.fn(async () => ({ id: 1, name: 'Current user' })),
      issueDetail: result.issueDetail,
      releaseIssues: vi.fn(async (versionId: number) => [...issues.values()].filter(issue => issue.fixedVersionId === versionId).map(issue => structuredClone(issue))),
      createIssue: result.createIssue,
      updateIssue: vi.fn(async (issueId: number, fields: Record<string, unknown>) => {
        updateAttempt++;
        updateCalls.push(structuredClone(fields));
        const failure = result.failUpdate?.(issueId, fields, updateAttempt);
        if (failure === 'unknown') throw new RedmineRequestError('Timed out waiting for Redmine', undefined, undefined, true);
        if (failure) throw new RedmineRequestError('Redmine validation failed', 422);
        const issue = issues.get(issueId)!;
        if (typeof fields.subject === 'string') issue.subject = fields.subject;
        if (typeof fields.description === 'string') issue.description = fields.description;
        if (typeof fields.status_id === 'number') issue.statusId = fields.status_id;
        if (typeof fields.assigned_to_id === 'number') issue.assignedToId = fields.assigned_to_id;
        else if (fields.assigned_to_id === null) delete issue.assignedToId;
        if (typeof fields.fixed_version_id === 'number') issue.fixedVersionId = fields.fixed_version_id;
        else if (fields.fixed_version_id === null) delete issue.fixedVersionId;
        if (fields.due_date === null) delete issue.dueDate;
        else if (typeof fields.due_date === 'string') issue.dueDate = fields.due_date;
        if (typeof fields.priority_id === 'number') issue.priorityId = fields.priority_id;
        if (typeof fields.tracker_id === 'number') issue.trackerId = fields.tracker_id;
        if (Array.isArray(fields.custom_fields)) for (const field of fields.custom_fields as { id: number; value: unknown }[]) {
          if (field.id === 50) issue.branch = String(field.value);
          if (field.id === 70) {
            issue.primaryAssigneeId = Number(field.value) || undefined;
            issue.developerId = issue.primaryAssigneeId;
          }
          if (field.id === 60 || field.id === 61) issue.labels = [...issue.labels.filter(label => !['one', 'two'].includes(label)),
            ...(field.value as string[]).map(id => id === '1' ? 'one' : 'two')];
        }
        issue.updatedOn = new Date().toISOString();
      }),
      createVersion: result.createVersion,
      updateVersion: result.updateVersion,
      versionDetail: vi.fn(async (id: number) => structuredClone(versions.get(id)!)),
      writeFieldMetadata: vi.fn(async () => ({ branchFieldId: 50, primaryAssigneeFieldId: 70, sampleIssueId: 1001,
        labelFieldIds: [60, 61], labelOptions: [
        { fieldId: 60, id: '1', name: 'one' }, { fieldId: 61, id: '2', name: 'two' },
      ] })),
    } as unknown as RedmineAdapter;
    return result;
  }

  it('rejects readonly writes before any remote read or mutation', async () => {
    const fake = harness();
    const readonly = service(fake.adapter, false);
    await expect(readonly.execute({ type: 'updateIssue', issueId: 1001, input: { subject: 'blocked' } }))
      .rejects.toMatchObject({ code: 'READ_ONLY', statusCode: 403 });
    expect(fake.issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
  });

  it('guards direct RealCommandExecutor entry before any adapter call when writes are disabled', async () => {
    const fake = harness();
    const executor = new RealCommandExecutor(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid',
      REDMINE_API_TOKEN: 'test-only-token', REDMINE_WRITE_ENABLED: 'false' }), fake.adapter, store);

    await expect(executor.execute({ type: 'updateIssue', issueId: 1001, input: { subject: 'blocked' } }))
      .rejects.toMatchObject({ code: 'READ_ONLY', statusCode: 403 });

    expect(fake.issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
    expect(fake.createIssue).not.toHaveBeenCalled();
    expect(fake.createVersion).not.toHaveBeenCalled();
    expect(fake.adapter.currentUser).not.toHaveBeenCalled();
  });

  it('blocks real journal edits before issue reads when the sync cannot verify permission', async () => {
    const fake = harness();
    await store.setValue('capabilities', { journalEditing: false, journalDeleting: false, journalLikes: false });

    const result = await service(fake.adapter).execute({ type: 'editJournal', issueId: 1001,
      input: { journalId: 7001, expectedNotes: 'old note', notes: 'new note' } });

    expect(result.operation).toMatchObject({ status: 'failed', errorCode: 'JOURNAL_EDIT_UNSUPPORTED' });
    expect(result.operation.error).toContain('Не вдалося підтвердити право');

    expect(fake.issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
    expect(fake.adapter.currentUser).not.toHaveBeenCalled();
  });

  it('records real journal likes as unsupported even if a stale capability bit is true', async () => {
    const fake = harness();
    const operationId = 'real-journal-like-unsupported';
    await store.setValue('capabilities', { journalEditing: false, journalDeleting: false, journalLikes: true });

    const result = await service(fake.adapter).execute({ type: 'setJournalLike', issueId: 1001, operationId,
      input: { journalId: 7001, liked: true } });

    expect(result.operation).toMatchObject({ status: 'failed', errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(result.operation.error).toContain('підтвердженого REST API');
    expect(await store.getOperationRecord(operationId)).toMatchObject({
      operation: { status: 'failed', errorCode: 'UNSUPPORTED_CAPABILITY' },
    });
    expect(store.getJournalLikeState(7001, 1)).toEqual({ count: 0, likedByMe: false });
    expect(fake.issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
    expect(fake.adapter.currentUser).not.toHaveBeenCalled();
  });

  it('durably blocks pending worker automation in read-only mode and never replays it after re-enable', async () => {
    const fake = harness();
    const operationId = 'pending-readonly-automation';
    await store.saveOperationRecord({
      operation: { id: operationId, type: 'runAutomation', issueId: 1001, status: 'pending', createdOn: new Date().toISOString(),
        steps: [{ name: 'Return issue to To Do', status: 'pending' }] },
      context: { realWrite: true, originalCommand: { type: 'runAutomation', issueId: 1001, operationId, input: {} },
        automationTrigger: { expectedUpdatedOn: demoIssues[0]!.updatedOn, reviewStatusId: demoIssues[0]!.statusId } },
    });
    const settings = await store.getSettings();
    settings.automationEnabled = false;
    await store.setSettings(settings);

    await service(fake.adapter, false).processPendingDemoAutomations();
    const blocked = await store.getOperationRecord(operationId);
    expect(blocked?.operation).toMatchObject({ status: 'blocked', errorCode: 'READ_ONLY' });
    expect(blocked?.context).toMatchObject({ readOnlyBlocked: true });
    expect(fake.issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
    expect(fake.adapter.currentUser).not.toHaveBeenCalled();

    const enabled = service(fake.adapter, true);
    settings.automationEnabled = true;
    await store.setSettings(settings);
    await enabled.processPendingDemoAutomations();
    expect((await store.getOperationRecord(operationId))?.operation).toMatchObject({ status: 'blocked', errorCode: 'READ_ONLY' });
    await expect(enabled.execute({ type: 'runAutomation', issueId: 1001, operationId, input: {} }))
      .rejects.toMatchObject({ code: 'READ_ONLY', statusCode: 409 });
    expect(fake.issueDetail).not.toHaveBeenCalled();
    expect(fake.updateCalls).toEqual([]);
    expect(fake.adapter.currentUser).not.toHaveBeenCalled();
  });

  it('creates an issue remotely, persists the returned ID, and writes its branch field', async () => {
    const fake = harness([]);
    const result = await service(fake.adapter).execute({ type: 'createIssue', projectId: 10, operationId: 'create-real-1', input: { subject: 'Remote issue' } });
    expect(result.operation.status).toBe('done');
    expect(fake.createIssue).toHaveBeenCalledOnce();
    expect(fake.createIssue.mock.calls[0]?.[0]).toMatchObject({ project_id: 10, subject: 'Remote issue', status_id: 2, priority_id: 4, tracker_id: 1 });
    expect(fake.updateCalls).toEqual([{ custom_fields: [{ id: 50, value: '9001-remote-issue' }] }]);
    expect(result.issue).toMatchObject({ id: 9001, branch: '9001-remote-issue' });
  });

  it('writes and clears Developer only through the verified Primary Assignee field ID', async () => {
    const fake = harness([1001]);
    const commands = service(fake.adapter);
    const assigned = await commands.execute({ type: 'updateIssue', issueId: 1001, input: { primaryAssigneeId: 3 } });
    expect(fake.updateCalls).toEqual([{ custom_fields: [{ id: 70, value: 3 }] }]);
    expect(assigned.issue).toMatchObject({ primaryAssigneeId: 3, developerId: 3, primaryAssigneeFieldId: 70 });

    fake.updateCalls.length = 0;
    const cleared = await commands.execute({ type: 'updateIssue', issueId: 1001, input: { primaryAssigneeId: null } });
    expect(fake.updateCalls).toEqual([{ custom_fields: [{ id: 70, value: '' }] }]);
    expect(cleared.issue?.primaryAssigneeId).toBeUndefined();
    expect(cleared.issue?.developerId).toBeUndefined();
  });

  it('writes a fresh project-member group and verifies the group identity from the reread issue', async () => {
    const fake = harness([1001]);
    const adapter = fake.adapter as unknown as {
      projectMemberships: ReturnType<typeof vi.fn>;
    };
    adapter.projectMemberships = vi.fn(async () => ({ userIds: [1, 2, 3], groups: [{ id: 2, name: 'Platform group' }] }));
    const updateIssue = fake.adapter.updateIssue.bind(fake.adapter);
    fake.adapter.updateIssue = vi.fn(async (issueId: number, fields: Record<string, unknown>) => {
      await updateIssue(issueId, fields);
      if (fields.assigned_to_id === 2) {
        const issue = fake.issues.get(issueId)!;
        issue.assignedToType = 'group';
        issue.assignedToName = 'Platform group';
      }
    });
    const commands = service(fake.adapter);
    const result = await commands.execute({ type: 'updateIssue', issueId: 1001,
      input: { assignedToId: 2, assignedToType: 'group' } });
    expect(result.operation.status).toBe('done');
    expect(result.issue).toMatchObject({ assignedToId: 2, assignedToType: 'group', assignedToName: 'Platform group' });
    expect(adapter.projectMemberships).toHaveBeenCalledWith(10);
    expect(fake.updateCalls).toEqual([{ assigned_to_id: 2 }]);
  });

  it('surfaces Redmine validation when a project member group is not assignable', async () => {
    const fake = harness([1001]);
    const adapter = fake.adapter as unknown as { projectMemberships: ReturnType<typeof vi.fn> };
    adapter.projectMemberships = vi.fn(async () => ({ userIds: [1, 2, 3], groups: [{ id: 2, name: 'Platform group' }] }));
    fake.failUpdate = (_issueId, fields) => fields.assigned_to_id === 2;
    const command = { type: 'updateIssue' as const, issueId: 1001, operationId: 'unassignable-member-group',
      input: { assignedToId: 2, assignedToType: 'group' as const } };
    await expect(service(fake.adapter).execute(command)).rejects.toMatchObject({ code: 'REDMINE_VALIDATION', statusCode: 422 });
    expect(fake.updateCalls).toEqual([{ assigned_to_id: 2 }]);
    expect((await store.getOperationRecord(command.operationId))?.operation).toMatchObject({ status: 'failed', errorCode: 'REDMINE_VALIDATION' });
  });

  it('refuses a Primary Assignee update before any PUT when the fresh issue has no confirmed field ID', async () => {
    const fake = harness([1001]);
    fake.adapter.writeFieldMetadata = vi.fn(async () => ({ branchFieldId: 50, labelFieldIds: [], labelOptions: [] })) as never;
    await expect(service(fake.adapter).execute({ type: 'updateIssue', issueId: 1001, input: { primaryAssigneeId: 3 } }))
      .rejects.toMatchObject({ code: 'PRIMARY_ASSIGNEE_FIELD_UNAVAILABLE' });
    expect(fake.updateCalls).toEqual([]);
  });

  it('retries a definite branch failure using the persisted created issue instead of posting twice', async () => {
    const fake = harness([]);
    fake.failUpdate = (_id, fields) => Array.isArray(fields.custom_fields);
    const commands = service(fake.adapter);
    const original = { type: 'createIssue' as const, projectId: 10, operationId: 'branch-retry', input: { subject: 'Retry branch write' } };
    await expect(commands.execute(original)).rejects.toMatchObject({ code: 'REDMINE_VALIDATION' });
    const saved = await store.getOperationRecord('branch-retry');
    expect(saved?.operation.issueId).toBe(9001);
    fake.failUpdate = undefined;
    const result = await commands.execute({ type: 'createIssue', operationId: 'branch-retry', issueId: 9001, input: {} });
    expect(result.operation.status).toBe('done');
    expect(fake.createIssue).toHaveBeenCalledOnce();
    expect(fake.issues.get(9001)?.branch).toBe('9001-retry-branch-write');
  });

  it('routes an updateIssue retry back through the QA handoff after the status checkpoint', async () => {
    const fake = harness([1001]);
    fake.failUpdate = (_id, fields) => fields.assigned_to_id === 3;
    const commands = service(fake.adapter);
    const original = { type: 'updateIssue' as const, issueId: 1001, operationId: 'qa-handoff-retry', input: { statusId: 5, qaId: 3, developerId: 2 } };
    await expect(commands.execute(original)).rejects.toMatchObject({ code: 'REDMINE_VALIDATION' });
    expect(fake.issues.get(1001)).toMatchObject({ statusId: 5, assignedToId: 1 });
    fake.failUpdate = undefined;
    const resumed = await commands.execute({ type: 'updateIssue', issueId: 1001, operationId: 'qa-handoff-retry', input: {} });
    expect(resumed.operation.status).toBe('done');
    expect(fake.updateCalls).toEqual([{ assigned_to_id: 1 }, { status_id: 5 }, { assigned_to_id: 3 }, { assigned_to_id: 3 }]);
    expect(resumed.issue).toMatchObject({ statusId: 5, assignedToId: 3, developerId: 2 });
  });

  it('resumes a created release from the returned version ID when membership fails', async () => {
    const fake = harness([1004]);
    fake.failUpdate = (_id, fields) => typeof fields.fixed_version_id === 'number';
    const commands = service(fake.adapter);
    const original = { type: 'createRelease' as const, projectId: 10, operationId: 'release-member-retry',
      input: { name: 'Release retry', issueIds: [1004] } };
    await expect(commands.execute(original)).rejects.toMatchObject({ code: 'REDMINE_VALIDATION' });
    const saved = await store.getOperationRecord('release-member-retry');
    expect(saved?.operation.versionId).toBe(8001);
    fake.failUpdate = undefined;
    const resumed = await commands.execute({ type: 'createRelease', operationId: 'release-member-retry', versionId: 8001, input: {} });
    expect(resumed.operation.status).toBe('done');
    expect(fake.createVersion).toHaveBeenCalledOnce();
    expect(fake.issues.get(1004)?.fixedVersionId).toBe(8001);
  });

  it('keeps ambiguous comment writes blocked and never sends them twice', async () => {
    const fake = harness([1001]);
    fake.failUpdate = (_id, fields) => typeof fields.notes === 'string' ? 'unknown' : false;
    const commands = service(fake.adapter);
    const command = { type: 'comment' as const, issueId: 1001, operationId: 'unknown-comment', input: { notes: 'one comment' } };
    await expect(commands.execute(command)).resolves.toMatchObject({ operation: { status: 'blocked', errorCode: 'OUTCOME_UNKNOWN' } });
    await expect(commands.execute({ ...command, input: {} })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fake.updateCalls.filter(fields => typeof fields.notes === 'string')).toHaveLength(1);
  });

  it('reconciles a successful CI automation write after its verification read fails', async () => {
    const fake = harness([1008]);
    const issue = fake.issues.get(1008)!;
    let reads = 0;
    fake.issueDetail.mockImplementation(async (id: number) => {
      reads++;
      if (reads === 2) throw new Error('temporary detail read failure');
      return { issue: structuredClone(fake.issues.get(id)!), journals: [], people: [] };
    });
    const command = { type: 'runAutomation' as const, issueId: 1008, operationId: 'automation-verification-retry', input: {} };
    const commands = service(fake.adapter);
    await commands.execute(command);
    const record = (await store.getOperationRecord(command.operationId))!;
    record.operation.status = 'pending';
    record.context = { ...(record.context ?? {}), automationTrigger: { expectedUpdatedOn: issue.updatedOn, reviewStatusId: 4, developerId: 2 } };
    await store.saveOperationRecord(record);
    const first = await commands.execute(command);
    expect(first.operation.status).toBe('failed');
    expect(fake.issues.get(1008)).toMatchObject({ statusId: 2, assignedToId: 2 });
    const retry = await commands.execute(command);
    expect(retry.operation.status).toBe('done');
    expect(fake.updateCalls).toHaveLength(1);
  });

  it('sends empty values for every configured Labels field so removal clears remote labels', async () => {
    const fake = harness([1001]);
    fake.issues.get(1001)!.labels = ['one', 'two'];
    const result = await service(fake.adapter).execute({ type: 'updateIssue', issueId: 1001, input: { labels: [] } });
    expect(result.operation.status).toBe('done');
    expect(fake.updateCalls).toEqual([{ custom_fields: [{ id: 60, value: [] }, { id: 61, value: [] }] }]);
    expect(fake.issues.get(1001)?.labels).toEqual([]);
  });

  it('prevalidates cross-project release members before creating a Version', async () => {
    const fake = harness([2001]);
    await expect(service(fake.adapter).execute({ type: 'createRelease', projectId: 10, input: { name: 'Wrong project', issueIds: [2001] } }))
      .rejects.toMatchObject({ code: 'CROSS_PROJECT_RELEASE' });
    expect(fake.createVersion).not.toHaveBeenCalled();
  });

  it('finishes a release by completing Deploy and preserving already completed Done members', async () => {
    const fake = harness([1002, 1003]);
    fake.issues.get(1002)!.statusId = 7;
    fake.issues.get(1002)!.fixedVersionId = 101;
    fake.issues.get(1003)!.statusId = 6;
    fake.issues.get(1003)!.fixedVersionId = 101;
    const result = await service(fake.adapter).execute({ type: 'finishRelease', versionId: 101, operationId: 'finish-release', input: {} });
    expect(result.operation.status).toBe('done');
    expect(fake.issues.get(1002)?.statusId).toBe(7);
    expect(fake.issues.get(1003)?.statusId).toBe(7);
    expect(fake.versions.get(101)?.status).toBe('closed');
    expect(fake.updateCalls.filter(fields => fields.status_id === 7)).toHaveLength(1);
  });

  it('rejects direct Version closure and does not call the Version write API', async () => {
    const fake = harness();
    await expect(service(fake.adapter).execute({ type: 'updateRelease', versionId: 101, input: { status: 'closed' } }))
      .rejects.toMatchObject({ code: 'USE_FINISH_RELEASE' });
    expect(fake.updateVersion).not.toHaveBeenCalled();
  });
});
