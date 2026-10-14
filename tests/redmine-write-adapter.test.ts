import { describe, expect, it } from 'vitest';
import { createConfig } from '../src/server/config.js';
import { RedmineAdapter } from '../src/server/redmine/adapter.js';

const config = () => createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid/team',
  REDMINE_API_TOKEN: 'mock-only-token', REDMINE_WRITE_ENABLED: 'true' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function createdIssue(id: number, custom_fields = [{ id: 43, name: 'Branch', value: `${id}-task` }, { id: 41, name: 'Labels', value: ['606'] }]) {
  return { id, project: { id: 42 }, subject: `Task ${id}`, description: 'Description', status: { id: 3, name: 'Review' },
    priority: { id: 4 }, tracker: { id: 2, name: 'Bug' }, author: { id: 1, name: 'Me' }, assigned_to: { id: 2, name: 'Dev' },
    created_on: '2026-10-05T10:00:00Z', updated_on: '2026-10-05T10:00:00Z', custom_fields };
}

describe('Redmine write adapter with mocked HTTP transport', () => {
  it('uses documented issue/version/journal JSON envelopes and maps create responses without a second GET', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init: init! });
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (url.pathname.endsWith('/issues.json') && init?.method === 'POST') return json({ issue: createdIssue(501) }, 201);
      if (url.pathname.endsWith('/issues/501.json') && init?.method === 'PUT') return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/projects/42/versions.json') && init?.method === 'POST') {
        return json({ version: { id: 801, project: { id: 42 }, name: 'October', status: 'open', due_date: '2026-10-31', description: 'Target' } }, 201);
      }
      if (url.pathname.endsWith('/versions/801.json') && init?.method === 'PUT') return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/versions/801.json') && init?.method === 'GET') {
        return json({ version: { id: 801, project: { id: 42 }, name: 'October', status: 'locked', description: 'Locked target' } });
      }
      if (url.pathname.endsWith('/journals/901.json') && init?.method === 'PUT') return new Response(null, { status: 204 });
      throw new Error(`Unexpected mocked request ${init?.method} ${url.pathname} ${JSON.stringify(body)}`);
    };
    const adapter = new RedmineAdapter(config(), fetcher);
    const issue = await adapter.createIssue({ project_id: 42, subject: 'Task 501', status_id: 3 }, [{ id: '606', name: 'Build: Succeeded', fieldId: 41 }]);
    expect(issue).toMatchObject({ id: 501, projectId: 42, branch: '501-task', labels: ['Build: Succeeded'] });
    await adapter.updateIssue(501, { notes: 'Comment', subject: 'Renamed' });
    const version = await adapter.createVersion(42, { name: 'October', description: 'Target' });
    await adapter.updateVersion(801, { status: 'closed' });
    expect(await adapter.versionDetail(801)).toMatchObject({ id: 801, projectId: 42, status: 'locked' });
    await adapter.updateJournal(901, 'Edited note');

    expect(calls.map(call => [call.init.method, call.url.pathname])).toEqual([
      ['POST', '/team/issues.json'], ['PUT', '/team/issues/501.json'], ['POST', '/team/projects/42/versions.json'],
      ['PUT', '/team/versions/801.json'], ['GET', '/team/versions/801.json'], ['PUT', '/team/journals/901.json'],
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ issue: { project_id: 42, subject: 'Task 501', status_id: 3 } });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ issue: { notes: 'Comment', subject: 'Renamed' } });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ version: { name: 'October', description: 'Target' } });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ version: { status: 'closed' } });
    expect(JSON.parse(String(calls[5]!.init.body))).toEqual({ journal: { notes: 'Edited note' } });
    expect(version).toMatchObject({ id: 801, projectId: 42, status: 'open', dueDate: '2026-10-31' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(2);
  });

  it('returns only write-safe custom-field metadata, with label IDs mapped to display names', async () => {
    const methods: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(String(init?.method ?? 'GET'));
      if (url.pathname.endsWith('/issues.json')) return json({ issues: [createdIssue(501, [
        { id: 43, name: 'Branch', value: 'private-branch-value' },
        { id: 41, name: 'Labels', value: ['606'] },
        { id: 42, name: 'Tags', value: ['api'] },
        { id: 44, name: 'Internal memo', value: 'private issue data' },
          { id: 45, name: 'Primary Assignee', value: '2' },
      ])] });
      if (url.pathname.endsWith('/custom_fields.json')) return json({ custom_fields: [
        { id: 43, name: 'Branch', projects: [{ id: 42 }] },
        { id: 41, name: 'Labels', projects: [{ id: 42 }], possible_values: [{ value: '606', label: 'Build: Succeeded' }] },
        { id: 42, name: 'Tags', projects: [{ id: 42 }], possible_values: ['api'] },
        { id: 44, name: 'Internal memo', projects: [{ id: 42 }], possible_values: ['private option'] },
          { id: 45, name: 'Primary Assignee', customized_type: 'issue', field_format: 'user', multiple: false,
            projects: [{ id: 42 }], trackers: [{ id: 2 }] },
          { id: 46, name: 'Primary Assignee', customized_type: 'issue', field_format: 'string', multiple: false,
            projects: [{ id: 42 }], trackers: [{ id: 2 }] },
      ] });
      throw new Error(`Unexpected mocked request ${init?.method} ${url.pathname}`);
    };
    const adapter = new RedmineAdapter(config(), fetcher);
    const metadata = await adapter.writeFieldMetadata(42);
    expect(metadata).toEqual({ branchFieldId: 43, primaryAssigneeFieldId: 45, sampleIssueId: 501, labelFieldIds: [41, 42], labelOptions: [
      { id: '606', name: 'Build: Succeeded', fieldId: 41 }, { id: 'api', name: 'api', fieldId: 42 },
    ] });
    expect(JSON.stringify(metadata)).not.toContain('private-branch-value');
    expect(JSON.stringify(metadata)).not.toContain('private issue data');
    expect(JSON.stringify(metadata)).not.toContain('private option');
    expect(methods.every(method => method === 'GET')).toBe(true);
  });

  it('uses a unique Primary Assignee field ID from the fresh issue when the admin catalog is forbidden', async () => {
    const calls: string[] = [];
    const adapter = new RedmineAdapter(config(), async input => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith('/issues/501.json')) return json({ issue: { id: 501, project: { id: 42 }, tracker: { id: 2 },
        custom_fields: [{ id: 43, name: 'Branch', value: '501-task' }, { id: 45, name: 'Primary Assignee', value: '' }] } });
      if (url.pathname.endsWith('/custom_fields.json')) return new Response('', { status: 403 });
      throw new Error(`Unexpected mock request ${url.pathname}`);
    });

    expect(await adapter.writeFieldMetadata(42, 501)).toEqual({ branchFieldId: 43, primaryAssigneeFieldId: 45,
      sampleIssueId: 501, labelFieldIds: [], labelOptions: [] });
    expect(calls).toEqual(['/team/issues/501.json', '/team/custom_fields.json']);
  });

  it.each([
    [{ id: 45, name: 'Primary Assignee', customized_type: 'issue', field_format: 'string', multiple: false,
      projects: [{ id: 42 }], trackers: [{ id: 2 }] }],
    [{ id: 45, name: 'Primary Assignee', customized_type: 'issue', field_format: 'user', multiple: true,
      projects: [{ id: 42 }], trackers: [{ id: 2 }] }],
  ])('rejects a Primary Assignee field when accessible metadata contradicts a single User field', async definition => {
    const adapter = new RedmineAdapter(config(), async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/issues/501.json')) return json({ issue: { id: 501, project: { id: 42 }, tracker: { id: 2 },
        custom_fields: [{ id: 45, name: 'Primary Assignee', value: '' }] } });
      if (url.pathname.endsWith('/custom_fields.json')) return json({ custom_fields: [definition] });
      throw new Error(`Unexpected mock request ${url.pathname}`);
    });
    expect((await adapter.writeFieldMetadata(42, 501)).primaryAssigneeFieldId).toBeUndefined();
  });

  it('does not guess a Primary Assignee ID when the fresh issue has duplicate exact names or array values', async () => {
    const getMetadata = async (custom_fields: { id: number; name: string; value: unknown }[]) => {
      const adapter = new RedmineAdapter(config(), async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/issues/501.json')) return json({ issue: { id: 501, project: { id: 42 }, tracker: { id: 2 }, custom_fields } });
        if (url.pathname.endsWith('/custom_fields.json')) return new Response('', { status: 403 });
        throw new Error(`Unexpected mock request ${url.pathname}`);
      });
      return adapter.writeFieldMetadata(42, 501);
    };
    expect((await getMetadata([{ id: 45, name: 'Primary Assignee', value: '' }, { id: 46, name: 'Primary Assignee', value: '' }]))
      .primaryAssigneeFieldId).toBeUndefined();
    expect((await getMetadata([{ id: 45, name: 'Primary Assignee', value: [] }])).primaryAssigneeFieldId).toBeUndefined();
  });
});
