import { afterEach, describe, expect, it } from 'vitest';
import { clearReleaseDraft, readReleaseDraft, releaseDraftStorageKey, writeReleaseDraft } from './releaseDraft';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const memory = new Map<string, string>();

function installStorage() {
  memory.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  } });
}

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('release draft storage', () => {
  it('isolates instance, project, form, and release version', () => {
    const create = releaseDraftStorageKey('demo:https://redmine.invalid:7', 3, 'new');
    const otherUser = releaseDraftStorageKey('demo:https://redmine.invalid:8', 3, 'new');
    const otherProject = releaseDraftStorageKey('demo:https://redmine.invalid:7', 4, 'new');
    const edit = releaseDraftStorageKey('demo:https://redmine.invalid:7', 3, 'edit', 10);
    const assign = releaseDraftStorageKey('demo:https://redmine.invalid:7', 3, 'assign', 10);
    const otherRelease = releaseDraftStorageKey('demo:https://redmine.invalid:7', 3, 'assign', 11);
    expect(new Set([create, otherUser, otherProject, edit, assign, otherRelease]).size).toBe(6);
  });

  it('restores a draft and removes it only when explicitly cleared', () => {
    installStorage();
    const key = releaseDraftStorageKey('scope', 9, 'edit', 42);
    const fallback = { name: '', dueDate: '', description: '' };
    writeReleaseDraft(key, { name: 'Release 2.4', dueDate: '2026-11-20', description: 'QA' });
    expect(readReleaseDraft(key, fallback)).toEqual({ name: 'Release 2.4', dueDate: '2026-11-20', description: 'QA' });
    clearReleaseDraft(key);
    expect(readReleaseDraft(key, fallback)).toEqual(fallback);
  });
});
