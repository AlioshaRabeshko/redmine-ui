import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type WorkspaceApp } from '../src/server/app.js';
import { applySettingsPatch, defaultSettings, parseSettingsPatch } from '../src/server/settings.js';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDataUrl = (suffix: number[]) => `data:image/png;base64,${Buffer.concat([pngSignature, Buffer.from(suffix)]).toString('base64')}`;
const urlFor = (projectId: number, version = randomUUID()) => `/api/projects/${projectId}/background?v=${version}`;

describe('per-project background images', () => {
  const openApps = new Set<WorkspaceApp>();
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const app of openApps) await app.close();
    openApps.clear();
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.length = 0;
  });

  async function openApp(options: Parameters<typeof createApp>[0] = {}): Promise<WorkspaceApp> {
    const app = await createApp({ databasePath: ':memory:', startWorker: false, ...options });
    openApps.add(app);
    return app;
  }

  async function upload(app: WorkspaceApp, projectId: number, dataUrl: string) {
    return app.inject({ method: 'PUT', url: `/api/projects/${projectId}/background`, payload: { dataUrl } });
  }

  it('uploads local images, serves exact versions, and retains the settings version until PATCH succeeds', async () => {
    const app = await openApp({ env: { APP_MODE: 'demo' } });
    const firstBytes = Buffer.concat([pngSignature, Buffer.from([1, 2, 3])]);
    const secondBytes = Buffer.concat([pngSignature, Buffer.from([4, 5, 6])]);
    const thirdBytes = Buffer.concat([pngSignature, Buffer.from([7, 8, 9])]);

    const firstUpload = await upload(app, 10, pngDataUrl([1, 2, 3]));
    expect(firstUpload.statusCode).toBe(200);
    expect(Object.keys(firstUpload.json())).toEqual(['url']);
    const firstUrl = firstUpload.json().url as string;
    expect(firstUrl).toMatch(/^\/api\/projects\/10\/background\?v=[0-9a-f-]{36}$/);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectBackgrounds: { '10': firstUrl } } })).statusCode).toBe(200);

    const firstRead = await app.inject(firstUrl);
    expect(firstRead.statusCode).toBe(200);
    expect(firstRead.headers['content-type']).toBe('image/png');
    expect(firstRead.headers['cache-control']).toBe('no-cache');
    expect(firstRead.rawPayload.equals(firstBytes)).toBe(true);

    const secondUpload = await upload(app, 10, pngDataUrl([4, 5, 6]));
    const secondUrl = secondUpload.json().url as string;
    expect((await app.inject(firstUrl)).rawPayload.equals(firstBytes)).toBe(true);
    expect((await app.inject(secondUrl)).rawPayload.equals(secondBytes)).toBe(true);
    expect((await app.inject('/api/projects/10/background')).rawPayload.equals(secondBytes)).toBe(true);

    const patchSecond = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectBackgrounds: { '10': secondUrl } } });
    expect(patchSecond.statusCode).toBe(200);
    const thirdUpload = await upload(app, 10, pngDataUrl([7, 8, 9]));
    const thirdUrl = thirdUpload.json().url as string;
    expect((await app.inject(secondUrl)).rawPayload.equals(secondBytes)).toBe(true);
    expect((await app.inject(thirdUrl)).rawPayload.equals(thirdBytes)).toBe(true);
    expect((await app.inject(firstUrl)).statusCode).toBe(404);

    const removed = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectBackgrounds: { '10': null } } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().projectBackgrounds['10']).toBeUndefined();
  });

  it('rejects inaccessible projects, unsupported images, MIME mismatches, and decoded payloads over 5 MiB', async () => {
    const app = await openApp({ env: { APP_MODE: 'demo' } });
    expect((await upload(app, 9999, pngDataUrl([1]))).statusCode).toBe(404);
    for (const dataUrl of [
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.concat([pngSignature, Buffer.from([1])]).toString('base64')}`,
      `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
      'data:image/png;base64,%%%=',
    ]) {
      expect((await upload(app, 10, dataUrl)).statusCode).toBe(400);
    }
    const oversized = Buffer.concat([pngSignature, Buffer.alloc(5 * 1024 * 1024 + 1 - pngSignature.length)]);
    const atLimit = await upload(app, 10, `data:image/png;base64,${oversized.subarray(0, 5 * 1024 * 1024).toString('base64')}`);
    expect(atLimit.statusCode, atLimit.body).toBe(200);
    const oversizedResponse = await upload(app, 10, `data:image/png;base64,${oversized.toString('base64')}`);
    expect(oversizedResponse.statusCode, oversizedResponse.body).toBe(400);
  });

  it('persists images within the Redmine instance scope without making outbound requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'redmine-background-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'workspace.sqlite');
    const fetcher = vi.fn();
    const project = { id: 42, name: 'Private project', identifier: 'private-project' };
    const first = await openApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://one.example.invalid' }, databasePath, fetcher });
    await first.backend.store.saveProject(project);
    const response = await upload(first, project.id, pngDataUrl([1, 2, 3]));
    const imageUrl = response.json().url as string;

    const reopened = await openApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://one.example.invalid' }, databasePath, fetcher });
    expect((await reopened.inject(imageUrl)).rawPayload.equals(Buffer.concat([pngSignature, Buffer.from([1, 2, 3])]))).toBe(true);

    const otherInstance = await openApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://two.example.invalid' }, databasePath, fetcher });
    await otherInstance.backend.store.saveProject(project);
    expect((await otherInstance.inject(imageUrl)).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('merges and removes project URL entries and upgrades settings missing the new map', async () => {
    const first = urlFor(10);
    const second = urlFor(20);
    const replacement = urlFor(10);
    const current = { ...structuredClone(defaultSettings), projectBackgrounds: { '10': first, '20': second } };
    const patch = parseSettingsPatch({ projectBackgrounds: { '10': replacement, '20': null } });
    expect(applySettingsPatch(current, patch).projectBackgrounds).toEqual({ '10': replacement });

    expect(() => parseSettingsPatch({ projectBackgrounds: { '10': 'https://outside.invalid/image.png' } })).toThrow();
    expect(() => parseSettingsPatch({ projectBackgrounds: { '10': '/api/projects/11/background?v=00000000-0000-4000-8000-000000000001' } })).toThrow();
    expect(() => parseSettingsPatch({ projectBackgrounds: { '10': 'data:image/png;base64,AAAA' } })).toThrow();

    const app = await openApp({ env: { APP_MODE: 'demo' } });
    const legacySettings = { ...structuredClone(defaultSettings) } as Record<string, unknown>;
    delete legacySettings.projectBackgrounds;
    await app.backend.store.setValue('settings', legacySettings);
    expect((await app.inject('/api/settings')).json().projectBackgrounds).toEqual({});
  });
});
