type DraftEntry = { kind: 'value'; value: string } | { kind: 'cleared' };

export type DraftStorageRead = { value: string | null; durable: boolean; present: boolean };

const sessionDrafts = new Map<string, DraftEntry>();
// Kept distinct from ordinary draft text so a failed remove cannot resurrect old content.
const CLEAR_MARKER = '\u0000redmine-workspace:draft-cleared:v1';

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function readDraftStorage(key: string): DraftStorageRead {
  const memoryEntry = sessionDrafts.get(key);
  if (memoryEntry) return { value: memoryEntry.kind === 'value' ? memoryEntry.value : null, durable: false, present: true };

  try {
    const target = storage();
    if (!target) return { value: null, durable: false, present: false };
    const raw = target.getItem(key);
    if (raw === CLEAR_MARKER) return { value: null, durable: true, present: true };
    return { value: raw, durable: true, present: raw !== null };
  } catch {
    return { value: null, durable: false, present: false };
  }
}

export function writeDraftStorage(key: string, value: string): boolean {
  try {
    const target = storage();
    if (!target) throw new Error('Browser storage is unavailable');
    target.setItem(key, value);
    sessionDrafts.delete(key);
    return true;
  } catch {
    sessionDrafts.set(key, { kind: 'value', value });
    return false;
  }
}

export function clearDraftStorage(key: string): boolean {
  try {
    const target = storage();
    if (!target) throw new Error('Browser storage is unavailable');
    target.removeItem(key);
    sessionDrafts.delete(key);
    return true;
  } catch {
    // The in-memory tombstone takes precedence over any stale persisted value for this tab.
    sessionDrafts.set(key, { kind: 'cleared' });
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(key, CLEAR_MARKER);
      sessionDrafts.delete(key);
      return true;
    } catch {
      return false;
    }
  }
}
