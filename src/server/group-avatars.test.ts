import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from './db/connection.js';
import { WorkspaceStore } from './db/store.js';
import { defaultSettings } from './settings.js';
import { ApiFault } from './commands/service.js';
import { registerGroupAvatarRoutes } from './group-avatars.js';

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=';

describe('local group avatars', () => {
  let opened: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let store: WorkspaceStore;

  beforeEach(async () => {
    opened = openDatabase(':memory:');
    migrate(opened.db, { migrationsFolder: 'drizzle' });
    store = new WorkspaceStore(opened.db, 'demo:isolated');
    await store.setSettings(structuredClone(defaultSettings));
    // ID 2 deliberately collides with a person ID; group routes must remain type-specific.
    await store.setValue('people', [{ id: 2, name: 'Same numeric ID' }]);
    await store.setValue('projectGroups', { '10': [{ id: 2, name: 'Platform group' }] });
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiFault) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      return reply.code(500).send({ code: 'INTERNAL_ERROR' });
    });
    registerGroupAvatarRoutes(app, store);
  });

  afterEach(async () => {
    await app.close();
    opened.close();
  });

  it('stores, reads, replaces, and removes a group photo without touching the colliding person key', async () => {
    const personBytes = [{ version: 'person-version', contentType: 'image/png', base64: 'person-data' }];
    await store.setValue('personAvatar:2', personBytes);

    const first = await app.inject({ method: 'PUT', url: '/api/groups/2/avatar', payload: { dataUrl: pngDataUrl } });
    expect(first.statusCode).toBe(200);
    const firstUrl = first.json<{ url: string }>().url;
    expect(firstUrl).toMatch(/^\/api\/groups\/2\/avatar\?v=[0-9a-f-]{36}$/i);
    expect(await store.getValue('personAvatar:2')).toEqual(personBytes);
    expect(await store.getValue('groupAvatar:2')).toEqual(expect.arrayContaining([expect.objectContaining({ version: firstUrl.split('=')[1] })]));

    const firstImage = await app.inject({ method: 'GET', url: firstUrl });
    expect(firstImage.statusCode).toBe(200);
    expect(firstImage.headers['content-type']).toBe('image/png');
    expect(firstImage.rawPayload.equals(Buffer.from(pngDataUrl.split(',')[1]!, 'base64'))).toBe(true);

    await store.setSettings({ ...structuredClone(defaultSettings), groupAvatarOverrides: { '2': { kind: 'photo', url: firstUrl } } });
    const second = await app.inject({ method: 'PUT', url: '/api/groups/2/avatar', payload: { dataUrl: pngDataUrl } });
    expect(second.statusCode).toBe(200);
    const secondUrl = second.json<{ url: string }>().url;
    await store.setSettings({ ...structuredClone(defaultSettings), groupAvatarOverrides: { '2': { kind: 'photo', url: secondUrl } } });

    expect((await app.inject({ method: 'DELETE', url: firstUrl })).json()).toEqual({ deleted: true });
    expect((await app.inject({ method: 'GET', url: firstUrl })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: secondUrl })).json()).toEqual({ deleted: false });
    expect((await app.inject({ method: 'GET', url: secondUrl })).statusCode).toBe(200);
  });

  it('requires a group observed in project membership and validates real image bytes and size', async () => {
    const unknownGroup = await app.inject({ method: 'PUT', url: '/api/groups/3/avatar', payload: { dataUrl: pngDataUrl } });
    expect(unknownGroup.statusCode).toBe(404);
    expect(await store.getValue('groupAvatar:3')).toBeUndefined();

    const mislabeled = await app.inject({ method: 'PUT', url: '/api/groups/2/avatar', payload: { dataUrl: 'data:image/jpeg;base64,aGVsbG8=' } });
    expect(mislabeled.statusCode).toBe(400);

    const oversizedBytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedBytes);
    const oversized = await app.inject({ method: 'PUT', url: '/api/groups/2/avatar', payload: { dataUrl: `data:image/png;base64,${oversizedBytes.toString('base64')}` } });
    expect(oversized.statusCode).toBe(400);
    expect(await store.getValue('groupAvatar:2')).toBeUndefined();
  });
});
