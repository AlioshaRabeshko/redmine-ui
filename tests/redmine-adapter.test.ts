import { describe, expect, it } from 'vitest';
import { createConfig } from '../src/server/config.js';
import { RedmineAdapter } from '../src/server/redmine/adapter.js';
import { createApp } from '../src/server/app.js';

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
    else if (url.pathname.endsWith('/projects.json')) body = { projects: [{ id: 10, name: 'Project', identifier: 'project', trackers: [
      { id: 1, name: '  Bug\u0000 ' }, { id: 2, name: ' Task ' }, { id: 0, name: 'Invalid' },
      { id: 3, name: '   ' }, { id: 1, name: 'Duplicate' }, { id: '4', name: 'String ID' },
    ] }], total_count: 1, limit: 100 };
    else if (url.pathname.endsWith('/versions.json')) body = { versions: [{ id: 99, project: { id: 10 }, name: 'NEXT', status: 'open' }] };
    else if (url.pathname.endsWith('/memberships.json')) body = { memberships: [{ user: { id: 2, name: 'Developer' }, roles: [{ id: 5, name: 'Developer' }] }] };
    else if (url.pathname.endsWith('/issues.json')) {
      const offset = Number(url.searchParams.get('offset'));
      const ids = url.searchParams.get('status_id') === 'closed' ? [] : [101, 102, 103];
      body = { issues: ids.slice(offset, offset + 2).map(rawIssue), total_count: ids.length, limit: 2, offset };
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
    expect(data.projects[0].trackers).toEqual([{ id: 1, name: 'Bug' }, { id: 2, name: 'Task' }]);
    expect(fixture.requested.find(url => url.pathname.endsWith('/projects.json'))?.searchParams.get('include')).toBe('trackers');
    const lists = fixture.requested.filter(url => url.pathname.endsWith('/issues.json') && url.searchParams.get('status_id') === 'open');
    expect(lists.map(url => Number(url.searchParams.get('offset')))).toEqual([0, 2]);
    expect(lists.every(url => url.searchParams.get('subproject_id') === '!*')).toBe(true);
    expect(data.branchFieldId).toBe(24);
    expect(data.labelsFieldId).toBe(23);
    expect(data.projectMembershipIds?.['10']).toEqual([2]);
    expect(data.projectMembershipRoles?.['10']?.['2']).toEqual([{ id: 5, name: 'Developer' }]);
    expect(JSON.stringify(data)).not.toContain('sensitive-api-response-key');
  });
  it.each([false, true])('reads a large unpaginated versions collection once (total_count present: %s)', async (hasTotalCount) => {
    const fixture = fixtureFetch();
    let versionRequests = 0;
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/versions.json')) {
        if (++versionRequests > 1) throw new Error('Unpaginated versions requested again');
        return new Response(JSON.stringify({ ...(hasTotalCount ? { total_count: 250 } : {}), versions: Array.from({ length: 250 }, (_, index) => ({
          id: index + 1, project: { id: 10 }, name: `Release ${index + 1}`, status: 'closed',
        })) }), { headers: { 'Content-Type': 'application/json' } });
      }
      return fixture.fetcher(input);
    };
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fetcher);
    const data = await adapter.snapshot();
    expect(versionRequests).toBe(1);
    expect(data.versions).toHaveLength(250);
    expect(new Set(data.versions.map(version => version.id)).size).toBe(250);
    expect(data.warnings.some(warning => warning.includes('релізи'))).toBe(false);
    expect(data.issues.map(issue => issue.id)).toEqual([101, 102, 103]);
  });

  it('includes closed tasks in active releases without downloading archived issues during the baseline', async () => {
    const fixture = fixtureFetch();
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/issues.json') && url.searchParams.get('status_id') === 'closed') {
        expect(url.searchParams.get('fixed_version_id')).toBe('99');
        const detail = await (await fixture.fetcher(new URL('https://redmine.example.invalid/issues/104.json'))).json();
        return new Response(JSON.stringify({ issues: [{ ...detail.issue, fixed_version: { id: 99 }, status: { id: 909, name: 'Done', is_closed: true } }], total_count: 1 }));
      }
      if (url.pathname.endsWith('/issues/104.json')) {
        const detail = await (await fixture.fetcher(input)).json();
        return new Response(JSON.stringify({ issue: { ...detail.issue, fixed_version: { id: 99 }, status: { id: 909, name: 'Done', is_closed: true } } }));
      }
      return fixture.fetcher(input);
    };
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fetcher);
    const baseline = await adapter.snapshot();
    expect(baseline.issues.map(issue => issue.id)).toEqual([101, 102, 103, 104]);
    expect(baseline.issues.find(issue => issue.id === 104)).toMatchObject({ statusId: 9, fixedVersionId: 99 });
    expect(fixture.requested.filter(url => url.pathname.endsWith('/issues.json')).every(url => url.searchParams.get('status_id') === 'open')).toBe(true);
  });

  it('reads archived releases and issue details on demand, retaining watchers and journals', async () => {
    const fixture = fixtureFetch();
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fixture.fetcher);
    expect((await adapter.releaseIssues(99, 10)).map(issue => issue.id)).toEqual([101, 102, 103]);
    expect(fixture.requested.filter(url => url.pathname.endsWith('/issues.json')).every(url => url.searchParams.get('fixed_version_id') === '99' && url.searchParams.get('status_id') === '*')).toBe(true);
    const detail = await adapter.issueDetail(101);
    expect(detail.issue.watcherIds).toEqual([1]);
    expect(detail.journals).toHaveLength(1);
    expect(detail.people.some(person => person.id === 2)).toBe(true);
  });

  it('loads an uncached archived issue and release through local routes without writes or stale deleted comments', async () => {
    const fixture = fixtureFetch();
    let removedNotes = false;
    const methods: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      const url = new URL(String(input));
      if (url.pathname.endsWith('/issues/999.json')) return new Response('', { status: 404 });
      const response = await fixture.fetcher(input);
      if (removedNotes && url.pathname.endsWith('/issues/104.json')) {
        const data = await response.json();
        data.issue.journals = [];
        return new Response(JSON.stringify(data));
      }
      return response;
    };
    const app = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }, databasePath: ':memory:', startWorker: false, fetcher });
    try {
      const bootstrap = (await app.inject('/api/bootstrap')).json();
      expect(bootstrap).toMatchObject({ connected: true, readOnly: true, capabilities: { canWrite: false } });
      expect(await app.backend.store.getIssue(104)).toBeUndefined();
      const issue = await app.inject('/api/issues/104');
      expect(issue.statusCode).toBe(200);
      expect(issue.json().journals).toHaveLength(1);
      await app.backend.store.setIssueRoles(104, 2, 3);
      removedNotes = true;
      const refreshed = (await app.inject('/api/issues/104')).json();
      expect(refreshed.journals).toEqual([]);
      expect(refreshed.issue).toMatchObject({ developerId: 2, qaId: 3 });
      const release = await app.inject('/api/releases/99');
      expect(release.statusCode).toBe(200);
      expect(release.json().issues).toHaveLength(3);
      expect((await app.inject('/api/issues/999')).statusCode).toBe(404);
      expect(methods.every(method => method === 'GET')).toBe(true);
    } finally { await app.close(); }
  });

  it('loads the first board without fetching every historical journal and preserves my watched filter', async () => {
    const fixture = fixtureFetch();
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fixture.fetcher);
    const data = await adapter.snapshot(undefined, undefined, false);
    expect(data.issues).toHaveLength(3);
    expect(data.journals).toEqual([]);
    expect(data.issues.every(issue => issue.watcherIds.includes(data.me.id))).toBe(true);
    expect(fixture.requested.some(url => /^\/issues\/\d+\.json$/.test(url.pathname))).toBe(false);
    expect(fixture.requested.some(url => url.searchParams.get('watcher_id') === 'me')).toBe(true);
  });

  it('uses whole seconds for updated_on compatibility and retains all statuses in incremental polls', async () => {
    const fixture = fixtureFetch();
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fixture.fetcher);
    await adapter.snapshot('2026-10-02T09:00:00.123Z');
    const lists = fixture.requested.filter(url => url.pathname.endsWith('/issues.json'));
    expect(lists.every(url => url.searchParams.get('updated_on') === '>=2026-10-02T09:00:00Z')).toBe(true);
    expect(lists.every(url => url.searchParams.get('status_id') === '*')).toBe(true);
  });

  it('fails incomplete detail hydration instead of falsely reporting a completed sync', async () => {
    const fixture = fixtureFetch(true);
    const adapter = new RedmineAdapter(createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-token' }), fixture.fetcher);
    await expect(adapter.snapshot('2026-10-02T09:00:00Z')).rejects.toThrow();
  });
});
