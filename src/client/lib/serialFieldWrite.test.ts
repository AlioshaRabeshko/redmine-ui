import { describe, expect, it } from 'vitest';
import { createIssueTextDraftKey, enqueueFieldWrite, issueTextDraftKey } from './serialFieldWrite';

describe('enqueueFieldWrite', () => {
  it('runs writes for the same field in order and continues after a failure', async () => {
    const queues = new Map<string, Promise<unknown>>();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueueFieldWrite(queues, 'statusId', async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push('first-failed');
      throw new Error('temporary failure');
    });
    const second = enqueueFieldWrite(queues, 'statusId', async () => {
      events.push('second-start');
      return 'saved';
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst();
    await expect(first).rejects.toThrow('temporary failure');
    await expect(second).resolves.toBe('saved');
    expect(events).toEqual(['first-start', 'first-failed', 'second-start']);
    expect(queues.has('statusId')).toBe(false);
  });

  it('lets unrelated fields save independently', async () => {
    const queues = new Map<string, Promise<unknown>>();
    let finishStatus!: () => void;
    const status = enqueueFieldWrite(queues, 'statusId', () => new Promise<void>((resolve) => { finishStatus = resolve; }));
    const priority = enqueueFieldWrite(queues, 'priorityId', async () => 'priority-saved');

    await expect(priority).resolves.toBe('priority-saved');
    finishStatus();
    await expect(status).resolves.toBeUndefined();
  });
});

describe('issue draft keys', () => {
  it('scopes text drafts by account, project, issue, and field', () => {
    const subject = issueTextDraftKey('demo:local/user', 7, 42, 'subject');
    expect(subject).not.toBe(issueTextDraftKey('demo:local/user', 7, 42, 'description'));
    expect(subject).not.toBe(issueTextDraftKey('redmine:local/user', 7, 42, 'subject'));
    expect(subject).not.toBe(issueTextDraftKey('demo:local/user', 8, 42, 'subject'));
    expect(subject).not.toBe(issueTextDraftKey('demo:local/user', 7, 43, 'subject'));
  });

  it('keeps new issue text drafts separate from field choices', () => {
    expect(createIssueTextDraftKey('demo:user', 7, 'subject')).not.toBe(createIssueTextDraftKey('demo:user', 7, 'description'));
    expect(createIssueTextDraftKey('demo:user', 7, 'subject')).not.toBe(createIssueTextDraftKey('demo:other-user', 7, 'subject'));
  });
});
