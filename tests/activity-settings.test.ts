import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type WorkspaceApp } from '../src/server/app.js';
import { defaultSettings, parseSettings } from '../src/server/settings.js';
import { defaultActivityVisibility } from '../src/shared/types.js';

describe('per-project activity preferences', () => {
  let app: WorkspaceApp | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('backfills older saved settings without changing their other values', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    const { projectActivity: _newField, ...legacy } = { ...defaultSettings, locale: 'pl' as const };
    await app.backend.store.setValue('settings', legacy);
    expect(await app.backend.store.getSettings()).toMatchObject({ locale: 'pl', projectActivity: {} });
    expect(parseSettings(legacy).projectActivity).toEqual({});
  });

  it('persists project-specific choices independently and restores the defaults', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    const first = { ...defaultActivityVisibility, labels: true };
    const second = { ...defaultActivityVisibility, status: false, field: true };
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectActivity: { '10': first } } });
    const saved = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectActivity: { '20': second } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().projectActivity).toEqual({ '10': first, '20': second });
    const reset = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectActivity: { '10': null } } });
    expect(reset.json().projectActivity).toEqual({ '20': second });
    expect(reset.json().subscriptions).toEqual(saved.json().subscriptions);
    expect((await app.backend.store.getSettings()).projectActivity).toEqual({ '20': second });
  });

  it('rejects malformed project IDs and incomplete or unrecognized event preferences', async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
    for (const projectActivity of [{ '0': defaultActivityVisibility }, { '10': { comment: true } }, { '10': { ...defaultActivityVisibility, arbitrary: true } }]) {
      const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { projectActivity } });
      expect(response.statusCode).toBe(400);
    }
    expect((await app.backend.store.getSettings()).projectActivity).toEqual({});
  });
});
