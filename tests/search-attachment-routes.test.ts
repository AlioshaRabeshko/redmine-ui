import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function realRedmineFetcher() {
  const requested: { url: URL; method: string }[] = [];
  const listIssue = {
    id: 321, project: { id: 10 }, subject: 'Cached task', description: 'Cached body',
    status: { id: 3, name: 'Review', is_closed: false }, priority: { id: 2 }, tracker: { id: 1, name: 'Task' },
    author: { id: 2, name: 'Author' }, assigned_to: { id: 1, name: 'Me' },
    created_on: '2026-10-01T10:00:00Z', updated_on: '2026-10-02T10:00:00Z', custom_fields: [],
  };
  const detailedIssue = { ...listIssue, status: { id: 7, name: 'Done', is_closed: true },
    description: 'Archived task body', attachments: [{ id: 55, filename: 'image.png', content_url: 'https://attacker.invalid/private.png',
      filesize: png.length, content_type: 'image/png' }], journals: [], watchers: [{ id: 1, name: 'Me' }] };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push({ url, method: init?.method ?? 'GET' });
    if (url.pathname.endsWith('/users/current.json')) return json({ user: { id: 1, name: 'Me' } });
    if (url.pathname.endsWith('/projects.json')) return json({ projects: [
      { id: 10, name: 'Project', identifier: 'project' }, { id: 20, name: 'Other', identifier: 'other' },
    ], total_count: 2, limit: 100 });
    if (url.pathname.endsWith('/issue_statuses.json')) return json({ issue_statuses: [
      { id: 3, name: 'Review', is_closed: false }, { id: 7, name: 'Done', is_closed: true },
    ] });
    if (url.pathname.endsWith('/enumerations/issue_priorities.json')) return json({ issue_priorities: [{ id: 2, name: 'Normal', position: 2 }] });
    if (url.pathname.endsWith('/versions.json')) return json({ versions: [], total_count: 0 });
    if (url.pathname.endsWith('/memberships.json')) return json({ memberships: [], total_count: 0 });
    if (url.pathname.endsWith('/issues.json')) {
      const rows = url.searchParams.get('status_id') === 'open' && !url.searchParams.has('watcher_id') ? [listIssue] : [];
      return json({ issues: rows, total_count: rows.length, limit: 100, offset: Number(url.searchParams.get('offset') ?? 0) });
    }
    const detailMatch = url.pathname.match(/\/issues\/(\d+)\.json$/);
    if (detailMatch) return Number(detailMatch[1]) === 321 ? json({ issue: detailedIssue }) : json({ errors: ['not found'] }, 404);
    if (url.pathname.endsWith('/attachments/download/55')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname.endsWith('/search.json')) return json({ results: [], total_count: 0, offset: 0, limit: 20 });
    throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
  };
  return { fetcher, requested };
}

describe('search and protected attachment routes', () => {
  it('searches the full cached demo issue and journal text, including completed issues', async () => {
    const app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    try {
      const completed = await app.inject('/api/search?q=Replace%20legacy%20signing%20helper&projectId=10');
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ total: 1, results: [{ id: 1010, statusName: 'Done' }] });
      const journal = await app.inject('/api/search?q=backoff&projectId=10');
      expect(journal.json().results.map((result: { id: number }) => result.id)).toContain(1001);
      const crossProject = await app.inject('/api/search?q=settlement%20status&projectId=all');
      expect(crossProject.json().results.map((result: { id: number }) => result.id)).toContain(2001);
      const idSearch = await app.inject('/api/search?q=%231010&projectId=10');
      expect(idSearch.json().results[0]?.id).toBe(1010);
      expect((await app.inject('/api/search?q=Done&projectId=999')).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('resolves exact Redmine IDs lazily and enforces selected-project access', async () => {
    const fixture = realRedmineFetcher();
    const app = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid/redmine', REDMINE_API_TOKEN: 'mock-token' },
      databasePath: ':memory:', startWorker: false, fetcher: fixture.fetcher });
    try {
      const exact = await app.inject('/api/search?q=%23321&projectId=10');
      expect(exact.statusCode).toBe(200);
      expect(exact.json()).toMatchObject({ total: 1, results: [{ id: 321, title: 'Cached task', statusName: 'Done', projectId: 10 }] });
      const wrongScope = await app.inject('/api/search?q=321&projectId=20');
      expect(wrongScope.statusCode).toBe(200);
      expect(wrongScope.json()).toMatchObject({ results: [], total: 0 });
      const absent = await app.inject('/api/search?q=999&projectId=10');
      expect(absent.json()).toMatchObject({ results: [], total: 0 });
      expect(fixture.requested.some(({ url }) => url.pathname.endsWith('/search.json'))).toBe(false);
      expect(fixture.requested.every(({ method }) => method === 'GET')).toBe(true);
    } finally { await app.close(); }
  });

  it('serves only an associated raster attachment through the same-origin backend route', async () => {
    const fixture = realRedmineFetcher();
    const app = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid/redmine', REDMINE_API_TOKEN: 'mock-token' },
      databasePath: ':memory:', startWorker: false, fetcher: fixture.fetcher });
    try {
      const detail = await app.inject('/api/issues/321');
      expect(detail.statusCode).toBe(200);
      expect(detail.json().issue.attachments[0]).toMatchObject({ contentType: 'image/png', thumbnailUrl: '/api/issues/321/attachments/55/content' });
      const content = await app.inject('/api/issues/321/attachments/55/content');
      expect(content.statusCode).toBe(200);
      expect(content.headers['content-type']).toBe('image/png');
      expect(content.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(content.rawPayload)).toEqual(png);
      const missing = await app.inject('/api/issues/321/attachments/56/content');
      expect(missing.statusCode).toBe(404);
      const download = fixture.requested.filter(({ url }) => url.pathname.includes('/attachments/download/'));
      expect(download).toHaveLength(1);
      expect(download[0]?.url.origin).toBe('https://redmine.example.invalid');
      expect(download[0]?.url.pathname).toBe('/redmine/attachments/download/55');
      expect(fixture.requested.some(({ url }) => url.origin === 'https://attacker.invalid')).toBe(false);
      expect(fixture.requested.every(({ method }) => method === 'GET')).toBe(true);
    } finally { await app.close(); }
  });
});
