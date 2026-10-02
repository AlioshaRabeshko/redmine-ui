import { useEffect, useRef, type RefObject } from 'react';

/** Serializes writes for one entity field while allowing unrelated fields to save in parallel. */
export function enqueueFieldWrite<T>(
  queues: Map<string, Promise<unknown>>,
  field: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(field);
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(write);
  queues.set(field, current);
  const cleanup = () => {
    if (queues.get(field) === current) queues.delete(field);
  };
  void current.then(cleanup, cleanup);
  return current;
}

export function issueTextDraftKey(scope: string, projectId: number, issueId: number, field: 'subject' | 'description' | 'branch' | 'dueDate' | 'comment'): string {
  return ['redmine-workspace', 'issue-draft', scope, String(projectId), String(issueId), field]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

export function createIssueTextDraftKey(scope: string, projectId: number, field: 'subject' | 'description'): string {
  return ['redmine-workspace', 'create-issue-draft', scope, String(projectId), field]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

/** Binds the app's scoped Cmd/Ctrl+S event to this form's normal submit path. */
export function useWorkspaceFormSave<T extends HTMLFormElement>(): RefObject<T | null> {
  const formRef = useRef<T>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onSaveRequest = (event: Event) => {
      if (event.target !== form) return;
      event.preventDefault();
      form.requestSubmit();
    };
    form.addEventListener('workspace:save-form', onSaveRequest);
    return () => form.removeEventListener('workspace:save-form', onSaveRequest);
  }, []);
  return formRef;
}
