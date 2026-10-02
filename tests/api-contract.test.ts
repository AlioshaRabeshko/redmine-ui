import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type WorkspaceApp } from '../src/server/app.js';
import type { Bootstrap } from '../src/shared/types.js';

describe('HTTP contract and development safety', () => {
  let app: WorkspaceApp | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('provides an isolated board and persists a created card without exposing server secrets', async () => {
    const fetcher = vi.fn();
    app = await createApp({ env: { APP_MODE: 'demo', REDMINE_API_TOKEN: 'secret-canary-test' }, databasePath: ':memory:', startWorker: false, fetcher });
    const bootResponse = await app.inject('/api/bootstrap');
    const boot = bootResponse.json() as Bootstrap;
    expect(bootResponse.statusCode).toBe(200);
    expect(boot.capabilities.canWrite).toBe(true);
    expect(bootResponse.body).not.toContain('secret-canary-test');
    const board = await app.inject(`/api/projects/${boot.projects[0].id}/board`);
    expect(board.json().trackers).toEqual([
      { id: 1, name: 'Feature' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Task' },
    ]);
    const created = await app.inject({ method: 'POST', url: '/api/commands', payload: { type: 'createIssue', projectId: boot.projects[0].id, input: { subject: 'HTTP creation' } } });
    expect(created.statusCode).toBe(200);
    const result = created.json();
    expect(result.issue.branch).toBe(`${result.issue.id}-http-creation`);
    const detail = await app.inject(`/api/issues/${result.issue.id}`);
    expect(detail.json().issue.subject).toBe('HTTP creation');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks real mutation commands before any outbound request while allowing local preferences', async () => {
    const fetcher = vi.fn();
    app = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://example.invalid', REDMINE_API_TOKEN: 'secret-canary-test' }, databasePath: ':memory:', startWorker: false, fetcher });
    for (const type of ['createIssue', 'updateIssue', 'moveIssue', 'handoffToQA', 'returnToDeveloper', 'comment', 'editJournal', 'deleteJournal', 'setJournalLike', 'createRelease', 'updateRelease', 'assignRelease', 'finishRelease', 'runAutomation']) {
      const response = await app.inject({ method: 'POST', url: '/api/commands', payload: { type, issueId: 1, projectId: 1, versionId: 1, input: {} } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('READ_ONLY');
      expect(response.body).not.toContain('secret-canary-test');
    }
    const settings = (await app.inject('/api/settings')).json();
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...settings, theme: 'dark', palette: 'amber', locale: 'en' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ theme: 'dark', palette: 'amber', locale: 'en' });
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read', payload: { ids: [] } })).statusCode).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a failed real connection without silently seeding demo data', async () => {
    const fetcher = vi.fn(async () => { throw new Error('secret-canary-test could appear in raw network errors'); });
    app = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://example.invalid', REDMINE_API_TOKEN: 'secret-canary-test' }, databasePath: ':memory:', startWorker: false, fetcher });
    const response = await app.inject('/api/bootstrap');
    expect(response.json()).toMatchObject({ mode: 'redmine', readOnly: true, connected: false, projects: [] });
    expect(response.body).not.toContain('secret-canary-test');
    expect(response.body).not.toContain('Core API');
  });

  it('rejects malformed requests and cross-site local writes cleanly', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    expect((await app.inject({ method: 'POST', url: '/api/commands', payload: { type: 'unknown' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/commands', headers: { 'content-type': 'application/json' }, payload: '{invalid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { theme: 'invalid' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read', payload: { ids: 'invalid' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' }, payload: { ids: [] } })).statusCode).toBe(403);
    expect((await app.inject('/api/issues/invalid')).statusCode).toBe(404);
  });
});
