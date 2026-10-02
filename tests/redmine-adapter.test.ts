import { describe, expect, it } from 'vitest';
import { createConfig } from '../src/server/config.js';
import { RedmineAdapter } from '../src/server/redmine/adapter.js';

function fixtureFetch(failDetail = false) {
  const requested: URL[] = [];
  const rawIssue = (id: number) => ({
    id, project: { id: 10 }, subject: `Task ${id}`, description: 'Body',
    status: { id: 903, name: 'Review' }, priority: { id: 88 }, author: { id: 2, name: 'Developer' },
    assigned_to: { id: 2, name: 'Developer' }, tracker: { id: 1, name: 'Task' },
    created_on: '2026-10-01T10:00:00Z', updated_on: '2026-10-02T10:00:00Z',
    custom_fields: [{ id: 23, name: 'Labels', value: ['Build: Failed'] }, { id: 24, name: 'Branch', value: `${id}-task` }],
  });
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input)); requested.push(url);
    let body: unknown;
    if (url.pathname.endsWith('/users/current.json')) body = { user: { id: 1, firstname: 'Me', lastname: 'User', api_key: 'sensitive-api-response-key' } };
    else if (url.pathname.endsWith('/issue_statuses.json')) body = { issue_statuses: [{ id: 903, name: 'Review', is_closed: false }] };
    else if (url.pathname.endsWith('/enumerations/issue_priorities.json')) body = { issue_priorities: [{ id: 88, name: 'Urgent', position: 5 }] };
    else if (url.pathname.endsWith('/projects.json')) body = { projects: [{ id: 10, name: 'Project', identifier: 'project' }], total_count: 1, limit: 100 };
    else if (url.pathname.endsWith('/versions.json')) body = { versions: [{ id: 99, project: { id: 10 }, name: 'NEXT', status: 'open' }] };
    else if (url.pathname.endsWith('/memberships.json')) body = { memberships: [{ user: { id: 2, name: 'Developer' } }] };
    else if (url.pathname.endsWith('/issues.json')) {
      const offset = Number(url.searchParams.get('offset'));
      body = { issues: [101, 102, 103].slice(offset, offset + 2).map(rawIssue), total_count: 3, limit: 2, offset };
    } else if (/\/issues\/\d+\.json$/.test(url.pathname)) {
      if (failDetail) return new Response('unavailable', { status: 503 });
      const id = Number(url.pathname.match(/(\d+)\.json$/)![1]);
      body = { issue: { ...rawIssue(id),
        watchers: [{ id: 1, name: 'Me User' }],
        journals: [{ id: id * 10, user: { id: 2, name: 'Developer' }, notes: 'Review comment', created_on: '2026-10-02T10:00:00Z', details: [] }],
      } };
    } else throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  return { fetcher, requested };
}

describe('Redmine read-only adapter integration contract', () => {
  it('loads all list pages and hydrates watcher/journal details absent from list responses', async () => {
    const fixture = fixtureFetch();
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fixture.fetcher);
    const data = await adapter.snapshot();
    expect(data.issues.map(i => i.id)).toEqual([101, 102, 103]);
    expect(data.issues.every(i => i.watcherIds.includes(1))).toBe(true);
    expect(data.journals).toHaveLength(3);
    expect(data.priorities[0].rank).toBe(5);
    const lists = fixture.requested.filter(url => url.pathname.endsWith('/issues.json'));
    expect(lists.map(url => Number(url.searchParams.get('offset')))).toEqual([0, 2]);
    expect(lists.every(url => url.searchParams.get('subproject_id') === '!*')).toBe(true);
    expect(data.branchFieldId).toBe(24);
    expect(data.labelsFieldId).toBe(23);
    expect(JSON.stringify(data)).not.toContain('sensitive-api-response-key');
  });
  it('fails incomplete detail hydration instead of falsely reporting a completed sync', async () => {
    const fixture = fixtureFetch(true);
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fixture.fetcher);
    await expect(adapter.snapshot('2026-10-02T09:00:00Z')).rejects.toThrow();
  });
});
