import { clearDraftStorage, readDraftStorage, writeDraftStorage } from './draftStorage';

export type ReleaseForm = 'new' | 'edit' | 'assign';

export function releaseDraftStorageKey(scope: string, projectId: number, form: ReleaseForm, versionId?: number): string {
  const versionKey = form === 'new' ? 'new' : String(versionId ?? 'missing');
  return `redmine-workspace:release-draft:${encodeURIComponent(scope)}:${projectId}:${form}:${versionKey}`;
}

export function readReleaseDraft<T extends object>(key: string, fallback: T): T {
  return readReleaseDraftState(key, fallback).draft;
}

export function readReleaseDraftState<T extends object>(key: string, fallback: T): { draft: T; durable: boolean } {
  const stored = readDraftStorage(key);
  try {
    if (!stored.value) return { draft: fallback, durable: stored.durable };
    const parsed: unknown = JSON.parse(stored.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { draft: fallback, durable: stored.durable };
    return { draft: { ...fallback, ...parsed } as T, durable: stored.durable };
  } catch { return { draft: fallback, durable: stored.durable }; }
}

export function writeReleaseDraft(key: string, draft: object): boolean {
  return writeDraftStorage(key, JSON.stringify(draft));
}

export function clearReleaseDraft(key: string): boolean {
  return clearDraftStorage(key);
}
