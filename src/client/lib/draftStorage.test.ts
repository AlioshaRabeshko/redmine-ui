import { afterEach, describe, expect, it } from 'vitest';
import { clearDraftStorage, readDraftStorage, writeDraftStorage } from './draftStorage';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let backing = new Map<string, string>();

function installStorage(overrides: Partial<Storage> = {}) {
  backing = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
    ...overrides,
  } });
}

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('scoped local draft storage', () => {
  it('uses durable storage normally and clears the value', () => {
    installStorage();
    const key = `draft:${crypto.randomUUID()}`;
    expect(writeDraftStorage(key, 'work in progress')).toBe(true);
    expect(readDraftStorage(key)).toEqual({ value: 'work in progress', durable: true, present: true });
    expect(clearDraftStorage(key)).toBe(true);
    expect(readDraftStorage(key)).toEqual({ value: null, durable: true, present: false });
  });

  it('keeps a failed write available in this session and marks it non-durable', () => {
    installStorage({ setItem: () => { throw new Error('quota'); } });
    const key = `draft:${crypto.randomUUID()}`;
    expect(writeDraftStorage(key, 'unsaved text')).toBe(false);
    expect(readDraftStorage(key)).toEqual({ value: 'unsaved text', durable: false, present: true });
  });

  it('replaces the session copy after storage recovers', () => {
    installStorage({ setItem: () => { throw new Error('quota'); } });
    const key = `draft:${crypto.randomUUID()}`;
    expect(writeDraftStorage(key, 'session copy')).toBe(false);
    installStorage();
    expect(writeDraftStorage(key, 'durable copy')).toBe(true);
    expect(readDraftStorage(key)).toEqual({ value: 'durable copy', durable: true, present: true });
  });

  it('clears the memory copy when a later clear succeeds', () => {
    installStorage({ setItem: () => { throw new Error('quota'); } });
    const key = `draft:${crypto.randomUUID()}`;
    expect(writeDraftStorage(key, 'session copy')).toBe(false);
    installStorage();
    expect(clearDraftStorage(key)).toBe(true);
    expect(readDraftStorage(key)).toEqual({ value: null, durable: true, present: false });
  });

  it('does not resurrect the old text when removal fails', () => {
    backing = new Map();
    const key = `draft:${crypto.randomUUID()}`;
    backing.set(key, 'old draft');
    installStorage({
      getItem: (requested) => backing.get(requested) ?? null,
      removeItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    // installStorage initializes the backing map, so seed the stale value after installation.
    backing.set(key, 'old draft');
    expect(clearDraftStorage(key)).toBe(false);
    expect(readDraftStorage(key)).toEqual({ value: null, durable: false, present: true });
  });

  it('writes a durable tombstone when remove is blocked but set is available', () => {
    installStorage({ removeItem: () => { throw new Error('blocked'); } });
    const key = `draft:${crypto.randomUUID()}`;
    backing.set(key, 'stale draft');
    expect(clearDraftStorage(key)).toBe(true);
    expect(readDraftStorage(key)).toEqual({ value: null, durable: true, present: true });
  });

  it('reports blocked or missing browser storage as non-durable', () => {
    const blockedKey = `draft:${crypto.randomUUID()}`;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    expect(readDraftStorage(blockedKey)).toEqual({ value: null, durable: false, present: false });
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(readDraftStorage(`draft:${crypto.randomUUID()}`)).toEqual({ value: null, durable: false, present: false });
  });
});
