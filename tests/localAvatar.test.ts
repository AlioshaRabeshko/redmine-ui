import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type WorkspaceApp } from '../src/server/app.js';
import { defaultSettings, parseSettings, parseSettingsPatch } from '../src/server/settings.js';
import { isSingleEmojiAvatar } from '../src/shared/types.js';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDataUrl = (suffix: number[]) => `data:image/png;base64,${Buffer.concat([pngSignature, Buffer.from(suffix)]).toString('base64')}`;

describe('local person avatar overrides', () => {
  const openApps = new Set<WorkspaceApp>();
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const app of openApps) await app.close();
    openApps.clear();
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.length = 0;
  });

  async function openDemo(databasePath = ':memory:'): Promise<WorkspaceApp> {
    const app = await createApp({ env: { APP_MODE: 'demo' }, databasePath, startWorker: false });
    openApps.add(app);
    return app;
  }

  async function upload(app: WorkspaceApp, personId: number, dataUrl: string) {
    return app.inject({ method: 'PUT', url: `/api/people/${personId}/avatar`, payload: { dataUrl } });
  }

  it('stores versioned local images, projects them to board/detail/inbox, and deletes only the requested version', async () => {
    const app = await openDemo();
    const firstBytes = Buffer.concat([pngSignature, Buffer.from([1, 2, 3])]);
    const secondBytes = Buffer.concat([pngSignature, Buffer.from([4, 5, 6])]);

    const firstUpload = await upload(app, 3, pngDataUrl([1, 2, 3]));
    expect(firstUpload.statusCode).toBe(200);
    const firstUrl = firstUpload.json().url as string;
    expect(firstUrl).toMatch(/^\/api\/people\/3\/avatar\?v=[0-9a-f-]{36}$/);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: {
      personAvatarOverrides: { '3': { kind: 'photo', url: firstUrl } },
    } })).statusCode).toBe(200);
    const firstRead = await app.inject(firstUrl);
    expect(firstRead.statusCode).toBe(200);
    expect(firstRead.headers['content-type']).toBe('image/png');
    expect(firstRead.headers['cache-control']).toBe('no-cache');
    expect(firstRead.headers['x-content-type-options']).toBe('nosniff');
    expect(firstRead.rawPayload.equals(firstBytes)).toBe(true);

    const secondUpload = await upload(app, 3, pngDataUrl([4, 5, 6]));
    const secondUrl = secondUpload.json().url as string;
    expect((await app.inject(firstUrl)).rawPayload.equals(firstBytes)).toBe(true);
    expect((await app.inject(secondUrl)).rawPayload.equals(secondBytes)).toBe(true);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: {
      personAvatarOverrides: { '3': { kind: 'photo', url: secondUrl } },
    } })).statusCode).toBe(200);

    const issue = await app.backend.store.getIssue(1001);
    await app.backend.store.saveIssue({ ...issue!, watcherIds: [...issue!.watcherIds, 3] });
    const journal = (await app.backend.store.getJournals(1001)).find(item => item.id === 9002)!;
    await app.backend.store.saveJournal(1001, { ...journal, user: { ...journal.user, roles: ['support'], redmineRoles: [{ id: 3, name: 'Support' }] } });

    const board10 = (await app.inject('/api/projects/10/board')).json();
    expect(board10.members.find((person: { id: number }) => person.id === 3)).toMatchObject({ avatar: secondUrl, roles: ['qa'] });
    const board20 = (await app.inject('/api/projects/20/board')).json();
    expect(board20.members.find((person: { id: number }) => person.id === 3).avatar).toBe(secondUrl);
    const detail = (await app.inject('/api/issues/1001')).json();
    expect(detail.journals.find((journal: { id: number }) => journal.id === 9002).user).toMatchObject({ avatar: secondUrl, roles: ['qa'], redmineRoles: [{ id: 2, name: 'QA' }] });
    expect(detail.watchers.find((person: { id: number }) => person.id === 3)).toMatchObject({ avatar: secondUrl, roles: ['qa'] });
    const inbox = (await app.inject('/api/notifications')).json();
    expect(inbox.find((notification: { actor: { id: number } }) => notification.actor.id === 3).actor).toMatchObject({ avatar: secondUrl, roles: ['qa'] });

    const cleared = await app.inject({ method: 'PATCH', url: '/api/settings', payload: {
      personAvatarOverrides: { '3': { kind: 'emoji', emoji: '👨‍👩‍👧‍👦' } },
    } });
    expect(cleared.statusCode).toBe(200);
    const projected = (await app.inject('/api/projects/10/board')).json().members.find((person: { id: number }) => person.id === 3);
    expect(projected.avatar).toBeUndefined();
    expect(projected.localEmoji).toBe('👨‍👩‍👧‍👦');
    const deleted = await app.inject({ method: 'DELETE', url: `/api/people/3/avatar?v=${secondUrl.split('=')[1]}` });
    expect(deleted.json()).toEqual({ deleted: true });
    expect((await app.inject(secondUrl)).statusCode).toBe(404);
  });

  it('honors project role overrides for known people outside Redmine membership IDs', async () => {
    const app = await openDemo();
    await app.backend.store.setValue('people', [
      ...((await app.backend.store.getValue<Array<{ id: number; name: string }>>('people')) ?? []),
      { id: 99, name: 'External collaborator' },
    ]);
    const members = await app.backend.store.getValue<Record<string, number[]>>('projectMembers') ?? {};
    await app.backend.store.setValue('projectMembers', { ...members, '10': [...members['10']!, 99] });
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: {
      personRoleOverrides: { '10': { '99': ['support'] } },
    } });
    expect(response.statusCode, response.body).toBe(200);
    const board = (await app.inject('/api/projects/10/board')).json();
    expect(board.members.find((person: { id: number }) => person.id === 99)).toMatchObject({ id: 99, roles: ['support'] });
  });

  it('rejects unsupported formats, MIME/signature mismatches, unknown people, and files over 2 MiB', async () => {
    const app = await openDemo();
    expect((await upload(app, 9999, pngDataUrl([1]))).statusCode).toBe(404);
    for (const dataUrl of [
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.concat([pngSignature, Buffer.from([1])]).toString('base64')}`,
      `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
      'data:image/png;base64,%%%= ',
    ]) {
      expect((await upload(app, 3, dataUrl)).statusCode).toBe(400);
    }
    const oversized = Buffer.concat([pngSignature, Buffer.alloc(2 * 1024 * 1024 + 1 - pngSignature.length)]);
    const response = await upload(app, 3, `data:image/png;base64,${oversized.toString('base64')}`);
    expect(response.statusCode).toBe(400);
  });

  it('isolates image bytes and preferences by instance and current user without outbound calls', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'redmine-person-avatar-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'workspace.sqlite');
    const fetcher = vi.fn();
    const first = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://one.example.invalid' }, databasePath, fetcher, startWorker: false });
    openApps.add(first);
    const firstInitialScope = first.backend.store.scope;
    first.backend.store.adoptInitialSettingsIntoUserScope(`${firstInitialScope}:user:7`, firstInitialScope);
    await first.backend.store.setValue('people', [{ id: 3, name: 'Known person' }]);
    const uploaded = await upload(first, 3, pngDataUrl([9, 8, 7]));
    const url = uploaded.json().url as string;
    expect(uploaded.statusCode).toBe(200);
    await first.backend.store.setSettings({ ...defaultSettings, personAvatarOverrides: { '3': { kind: 'photo', url } } });

    const otherUser = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://one.example.invalid' }, databasePath, fetcher, startWorker: false });
    openApps.add(otherUser);
    const otherUserInitialScope = otherUser.backend.store.scope;
    otherUser.backend.store.adoptInitialSettingsIntoUserScope(`${otherUserInitialScope}:user:8`, otherUserInitialScope);
    expect((await otherUser.inject(url)).statusCode).toBe(404);
    expect((await otherUser.inject('/api/settings')).json().personAvatarOverrides).toEqual({});

    const otherInstance = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://two.example.invalid' }, databasePath, fetcher, startWorker: false });
    openApps.add(otherInstance);
    expect((await otherInstance.inject(url)).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates same-person photo URLs and accepts a single grapheme emoji including flags and ZWJ sequences', () => {
    const photoUrl = `/api/people/3/avatar?v=${randomUUID()}`;
    expect(parseSettingsPatch({ personAvatarOverrides: { '3': { kind: 'photo', url: photoUrl } } })).toEqual({
      personAvatarOverrides: { '3': { kind: 'photo', url: photoUrl } },
    });
    expect(() => parseSettingsPatch({ personAvatarOverrides: { '4': { kind: 'photo', url: photoUrl } } })).toThrow();
    expect(() => parseSettings({ ...defaultSettings, personAvatarOverrides: { '4': { kind: 'photo', url: photoUrl } } })).toThrow();
    expect(isSingleEmojiAvatar('🇬🇪')).toBe(true);
    expect(isSingleEmojiAvatar('👨‍👩‍👧‍👦')).toBe(true);
    expect(isSingleEmojiAvatar('😀x')).toBe(false);
    expect(() => parseSettingsPatch({ personAvatarOverrides: { '3': { kind: 'emoji', emoji: '😀x' } } })).toThrow();
  });
});
