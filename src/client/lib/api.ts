import type { ApiError, Command, CommandResult } from '../../shared/types';

export class ApiRequestError extends Error {
  code: string;
  details?: unknown;

  constructor(error: ApiError | undefined, fallback: string, status: number) {
    super(error?.message || fallback);
    this.name = 'ApiRequestError';
    this.code = error?.code || `HTTP_${status}`;
    this.details = error?.details;
  }
}

export function friendlyError(error: unknown, t: (key: string) => string): string {
  const code = error instanceof ApiRequestError ? error.code : '';
  const notFound = ['NOT_FOUND', 'ISSUE_NOT_FOUND', 'VERSION_NOT_FOUND', 'PROJECT_NOT_FOUND', 'JOURNAL_NOT_FOUND'];
  const conflicts = ['CONFLICT', 'STALE', 'OPERATION_CONFLICT', 'ISSUE_ID_CONFLICT', 'RELEASE_MEMBERSHIP_CHANGED', 'CROSS_PROJECT_RELEASE', 'JOURNAL_CONFLICT'];
  const permissions = ['FORBIDDEN', 'PERMISSION_DENIED', 'ORIGIN_REJECTED', 'JOURNAL_FORBIDDEN'];
  const validation = ['VALIDATION', 'VALIDATION_ERROR', 'BAD_REQUEST', 'INVALID_SETTINGS', 'INVALID_SEARCH', 'INVALID_ROLE', 'UNKNOWN_COMMAND', 'BRANCH_INVALID', 'COMMENT_REQUIRED', 'ISSUES_REQUIRED', 'ISSUE_REQUIRED', 'VERSION_REQUIRED', 'PROJECT_REQUIRED', 'SUBJECT_REQUIRED', 'STATUS_REQUIRED', 'PRIORITY_REQUIRED', 'RELEASE_NAME_REQUIRED', 'JOURNAL_REQUIRED', 'LIKED_REQUIRED', 'LIKE_STATE_REQUIRED', 'EXPECTED_NOTES_REQUIRED'];
  const key = code === 'QA_REQUIRED' ? 'errorQaRequired'
    : code === 'DEVELOPER_REQUIRED' ? 'errorDeveloperRequired'
      : code === 'RELEASE_NOT_READY' ? 'errorReleaseNotReady'
        : code === 'TRANSITION_NOT_ALLOWED' ? 'errorTransitionNotAllowed'
          : code === 'OPERATION_BLOCKED' ? 'errorOperationBlocked'
            : code === 'READ_ONLY' ? 'errorReadOnly'
              : notFound.includes(code) ? 'errorNotFound'
                : conflicts.includes(code) ? 'errorConflict'
                  : permissions.includes(code) ? 'errorPermission'
                    : validation.includes(code) ? 'errorValidation'
                      : ['REDBLOCKED', 'CONNECTION', 'SYNC_FAILED', 'REDMINE_UNAVAILABLE', 'REDMINE_REQUEST_FAILED'].includes(code) ? 'errorConnection'
                        : 'errorGeneric';
  return t(key);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('Only local /api requests are allowed.');
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!response.ok) {
    throw new ApiRequestError(data as ApiError | undefined, response.statusText || 'Request failed', response.status);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  put: <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  post: <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  command: (command: Command) => request<CommandResult>('/api/commands', { method: 'POST', body: JSON.stringify(command) }),
};

export function issueUrl(base: string, issueId: number): string {
  return `${base.replace(/\/$/, '')}/issues/${issueId}`;
}
