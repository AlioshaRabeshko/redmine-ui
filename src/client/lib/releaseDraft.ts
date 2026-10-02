export type ReleaseForm = 'new' | 'edit' | 'assign';

export function releaseDraftStorageKey(scope: string, projectId: number, form: ReleaseForm, versionId?: number): string {
  const versionKey = form === 'new' ? 'new' : String(versionId ?? 'missing');
  return `redmine-workspace:release-draft:${encodeURIComponent(scope)}:${projectId}:${form}:${versionKey}`;
}

export function readReleaseDraft<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...parsed } as T;
  } catch { return fallback; }
}

export function writeReleaseDraft(key: string, draft: object): void {
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep form editing available when browser storage is unavailable. */ }
}

export function clearReleaseDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* A successful save must remain successful if local cleanup fails. */ }
}
