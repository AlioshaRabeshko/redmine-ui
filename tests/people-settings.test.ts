import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type WorkspaceApp } from '../src/server/app.js';
import { defaultSettings } from '../src/server/settings.js';

describe('project people, recommendations, and settings patches', () => {
  let app: WorkspaceApp | undefined;
  let databaseDirectory: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
    databaseDirectory = undefined;
  });

  async function createDemo(databasePath = ':memory:'): Promise<WorkspaceApp> {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath, startWorker: false });
    return app;
  }

  it('adds tracker metadata to an existing demo database without replacing local data', async () => {
    const server = await createDemo();
    const store = server.backend.store;
    const project = (await store.getProjects()).find(entry => entry.id === 10)!;
    await store.saveProject({ ...project, name: 'My existing project', trackers: undefined });
    await server.backend.commands.patchSettings({ theme: 'dark' });
    const before = { issues: await store.getIssues(), versions: await store.getVersions(), settings: await store.getSettings() };
    await store.initializeDemo();
    const updated = (await store.getProjects()).find(entry => entry.id === 10)!;
    expect(updated.name).toBe('My existing project');
    expect(updated.trackers).toContainEqual({ id: 2, name: 'Bug' });
    expect(await store.getIssues()).toEqual(before.issues);
    expect(await store.getVersions()).toEqual(before.versions);
    expect(await store.getSettings()).toEqual(before.settings);
  });

  it('enriches people with project roles and local overrides only in the project context', async () => {
    const server = await createDemo();
    const core = (await server.inject('/api/projects/10/board')).json();
    const qa = core.members.find((person: { id: number }) => person.id === 3);
    const me = core.members.find((person: { id: number }) => person.id === 1);
    expect(qa).toMatchObject({ roles: ['qa'], redmineRoles: [{ id: 2, name: 'QA' }] });
    expect(me.roles).toBeUndefined();

    const saved = await server.inject({ method: 'PATCH', url: '/api/settings', payload: {
      personRoleOverrides: { '10': { '3': ['support', 'developer'] } },
    } });
    expect(saved.statusCode).toBe(200);
    const updated = (await server.inject('/api/projects/10/board')).json();
    expect(updated.members.find((person: { id: number }) => person.id === 3)).toMatchObject({
      roles: ['support', 'developer'], redmineRoles: [{ id: 2, name: 'QA' }],
    });
    const otherProject = (await server.inject('/api/projects/20/board')).json();
    expect(otherProject.members.find((person: { id: number }) => person.id === 3).roles).toEqual(['qa']);
  });

  it('merges settings field patches, merges project entries, and supports explicit deletion', async () => {
    const server = await createDemo();
    const initial = (await server.inject('/api/settings')).json();
    const patched = await server.inject({ method: 'PATCH', url: '/api/settings', payload: {
      theme: 'dark', projectQa: { '10': 5 }, subscriptions: { '10': null },
      personRoleOverrides: { '10': { '2': ['support'], '3': ['qa'] } },
    } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ theme: 'dark', projectQa: { '10': 5 }, personRoleOverrides: { '10': { '2': ['support'], '3': ['qa'] } } });
    expect(patched.json().shortcuts).toEqual(initial.shortcuts);
    expect(patched.json().subscriptions['10']).toBeUndefined();
    const savedFilter = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { savedViews: [{
      id: 'labels-and-mine', projectId: 10, name: 'Mine bug labels', view: 'all', filters: { labels: ['bug', 'payments'], assignedToMe: true },
    }] } });
    expect(savedFilter.statusCode).toBe(200);
    expect(savedFilter.json().savedViews[0].filters).toEqual({ labels: ['bug', 'payments'], assignedToMe: true });

    const deleted = await server.inject({ method: 'PATCH', url: '/api/settings', payload: {
      projectQa: { '10': null }, personRoleOverrides: { '10': { '2': null } },
    } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().projectQa['10']).toBeUndefined();
    expect(deleted.json().personRoleOverrides['10']).toEqual({ '3': ['qa'] });
    expect((await server.inject({ method: 'PATCH', url: '/api/settings', payload: { personRoleOverrides: { '10': null } } })).json().personRoleOverrides['10']).toBeUndefined();
    expect((await server.inject({ method: 'PATCH', url: '/api/settings', payload: { projectQa: { '10': 99 } } })).statusCode).toBe(400);
  });

  it('preserves an existing Cmd/Ctrl+S shortcut when adding the legacy default', async () => {
    const server = await createDemo();
    const legacy = structuredClone(defaultSettings);
    legacy.shortcuts = [...legacy.shortcuts.filter(shortcut => shortcut.action !== 'saveForm'),
      { id: 'custom-save', keys: 'Ctrl+S', action: 'customSave', enabled: true }];
    await server.backend.store.setValue('settings', legacy);
    await server.backend.store.setValue('settingsSchemaVersion', 0);
    const migrated = (await server.inject('/api/settings')).json();
    expect(migrated.shortcuts.some((shortcut: { id: string }) => shortcut.id === 'custom-save')).toBe(true);
    expect(migrated.shortcuts.some((shortcut: { action: string }) => shortcut.action === 'saveForm')).toBe(false);
  });

  it('counts successful manual choices once, rejects failed choices, and skips automation', async () => {
    const server = await createDemo();
    async function updateAssignment(issueId: number, personId: number, operationId: string) {
      const command = await server.inject({ method: 'POST', url: '/api/commands', payload: {
        type: 'updateIssue', issueId, operationId, input: { assignedToId: personId },
      } });
      expect(command.statusCode).toBe(200);
      expect(command.json().operation.status).toBe('done');
      return server.inject({ method: 'POST', url: '/api/people/selection', payload: {
        projectId: 10, personId, field: 'assignee', operationId,
      } });
    }

    expect((await updateAssignment(1004, 3, 'manual-assignee-1')).json()).toEqual({ recorded: true });
    expect((await server.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 10, personId: 3, field: 'assignee', operationId: 'manual-assignee-1',
    } })).json()).toEqual({ recorded: false, duplicate: true });
    expect((await updateAssignment(1005, 3, 'manual-assignee-2')).json()).toEqual({ recorded: true });
    expect((await updateAssignment(1006, 2, 'manual-assignee-3')).json()).toEqual({ recorded: true });
    const roleSaved = await server.inject({ method: 'POST', url: '/api/issues/1004/roles', payload: {
      developerId: 5, operationId: 'manual-developer-role',
    } });
    expect(roleSaved.statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 10, personId: 5, field: 'developer', operationId: 'manual-developer-role',
    } })).json()).toEqual({ recorded: true });
    expect((await server.inject({ method: 'POST', url: '/api/issues/1004/roles', payload: {
      developerId: 4, operationId: 'manual-developer-role',
    } })).statusCode).toBe(409);

    const failed = await server.inject({ method: 'POST', url: '/api/commands', payload: {
      type: 'updateIssue', issueId: 1006, operationId: 'failed-assignee', input: { subject: '  ' },
    } });
    expect(failed.statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 10, personId: 5, field: 'assignee', operationId: 'failed-assignee',
    } })).statusCode).toBe(409);

    const autoHandoff = await server.inject({ method: 'POST', url: '/api/commands', payload: {
      type: 'handoffToQA', issueId: 1001, operationId: 'automatic-handoff', input: {},
    } });
    expect(autoHandoff.json().operation.status).toBe('done');
    expect((await server.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 10, personId: 3, field: 'qa', operationId: 'automatic-handoff',
    } })).json()).toMatchObject({ recorded: false });

    const board = (await server.inject('/api/projects/10/board')).json();
    expect(board.peopleRecommendations.assignee.slice(0, 2)).toEqual([3, 2]);
    expect(board.peopleRecommendations.developer).toEqual([5]);
    expect(board.peopleRecommendations.qa).toEqual([]);
    expect((await server.inject({ method: 'PATCH', url: '/api/settings', payload: { projectQa: { '20': 3 } } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 20, personId: 3, field: 'qa', operationId: 'manual-qa-setting-project-20',
    } })).json()).toEqual({ recorded: true });
    expect((await server.inject('/api/projects/20/board')).json().peopleRecommendations.qa).toEqual([3]);
    expect((await server.inject('/api/projects/10/board')).json().peopleRecommendations.qa).toEqual([]);
    expect((await server.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 20, personId: 2, field: 'assignee', operationId: 'not-a-member',
    } })).statusCode).toBe(400);
  });

  it('records local QA settings choices and persists recommendation and Cmd+S migration across restart', async () => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'redmine-workspace-people-'));
    const path = join(databaseDirectory, 'workspace.sqlite');
    const firstServer = await createDemo(path);
    const legacy = structuredClone(defaultSettings);
    legacy.shortcuts = legacy.shortcuts.filter(shortcut => shortcut.action !== 'saveForm');
    await firstServer.backend.store.setValue('settings', legacy);
    await firstServer.backend.store.setValue('settingsSchemaVersion', 0);
    const migrated = (await firstServer.inject('/api/settings')).json();
    expect(migrated.shortcuts.some((shortcut: { action: string; keys: string }) => shortcut.action === 'saveForm' && shortcut.keys === 'Mod+S')).toBe(true);
    const operationId = 'saved-project-qa-setting';
    expect((await firstServer.inject({ method: 'PATCH', url: '/api/settings', payload: { projectQa: { '10': 3 } } })).statusCode).toBe(200);
    expect((await firstServer.inject({ method: 'POST', url: '/api/people/selection', payload: {
      projectId: 10, personId: 3, field: 'qa', operationId,
    } })).json()).toEqual({ recorded: true });
    await firstServer.close();
    app = undefined;

    const secondServer = await createDemo(path);
    const board = (await secondServer.inject('/api/projects/10/board')).json();
    expect(board.peopleRecommendations.qa).toEqual([3]);
    expect((await secondServer.inject('/api/settings')).json().shortcuts.some((shortcut: { action: string }) => shortcut.action === 'saveForm')).toBe(true);
  });

  it('rejects stale issue updates before changing the stored issue', async () => {
    const server = await createDemo();
    const issue = await server.backend.store.getIssue(1004);
    expect(issue).toBeDefined();
    await server.backend.store.saveIssue({ ...issue!, subject: 'Changed by another client', updatedOn: '2026-09-01T10:00:00.000Z' });
    const stale = await server.inject({ method: 'POST', url: '/api/commands', payload: {
      type: 'updateIssue', issueId: 1004, operationId: 'stale-field-update', input: {
        expectedUpdatedOn: issue!.updatedOn, subject: 'Overwrite attempt',
      },
    } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('STALE');
    expect((await server.backend.store.getIssue(1004))?.subject).toBe('Changed by another client');
  });
});
