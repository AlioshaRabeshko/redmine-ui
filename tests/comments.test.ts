import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type WorkspaceApp } from '../src/server/app.js';
import type { Command, Journal, Person } from '../src/shared/types.js';

describe('comment commands in isolated demo mode', () => {
  let app!: WorkspaceApp;
  beforeEach(async () => {
    app = await createApp({ env: { APP_MODE: 'demo' }, databasePath: ':memory:', startWorker: false });
  });
  afterEach(async () => { await app.close(); });

  const send = (command: Command) => app.inject({ method: 'POST', url: '/api/commands', payload: command });
  const readDetail = async (issueId = 1001) => app.inject(`/api/issues/${issueId}`);

  it('edits an owned comment, rejects stale notes, and replays the same operation only once', async () => {
    const created = await send({ type: 'comment', issueId: 1001, operationId: 'comment-create', input: { notes: 'First draft' } });
    expect(created.statusCode).toBe(200);
    const detail = (await readDetail()).json();
    const comment = detail.journals.find((journal: Journal) => journal.notes === 'First draft');
    expect(comment).toMatchObject({ canEdit: true, canDelete: true, canLike: true, likes: 0, likedByMe: false });

    const edit: Command = { type: 'editJournal', issueId: 1001, operationId: 'comment-edit', input: {
      journalId: comment.id, expectedNotes: 'First draft', notes: 'Updated comment',
    } };
    expect((await send(edit)).statusCode).toBe(200);
    expect((await send(edit)).statusCode).toBe(200);
    const edited = (await readDetail()).json().journals.filter((journal: Journal) => journal.notes === 'Updated comment');
    expect(edited).toHaveLength(1);

    const stale = await send({ ...edit, operationId: 'stale-edit', input: { ...edit.input, expectedNotes: 'First draft', notes: 'Lost update' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('STALE');
    expect((await app.backend.store.getJournals(1001)).find(journal => journal.id === comment.id)?.notes).toBe('Updated comment');
  });

  it('blocks foreign-author edits and deletes before changing the journal', async () => {
    const before = (await app.backend.store.getJournals(1001)).find(journal => journal.id === 9002)!;
    expect(before.user.id).not.toBe(1);
    const edit = await send({ type: 'editJournal', issueId: 1001, input: {
      journalId: before.id, expectedNotes: before.notes, notes: 'Unauthorized edit',
    } });
    expect(edit.statusCode).toBe(403);
    expect(edit.json().code).toBe('JOURNAL_FORBIDDEN');
    const deletion = await send({ type: 'deleteJournal', issueId: 1001, input: {
      journalId: before.id, expectedNotes: before.notes,
    } });
    expect(deletion.statusCode).toBe(403);
    expect((await app.backend.store.getJournals(1001)).find(journal => journal.id === before.id)).toEqual(before);
  });

  it('allows an admin to remove note text while retaining journal changes', async () => {
    await app.backend.store.setValue('me', { id: 1, name: 'Демо адміністратор', isAdmin: true } satisfies Person);
    const before = (await app.backend.store.getJournals(1001)).find(journal => journal.id === 9001)!;
    expect(before.changes.length).toBeGreaterThan(0);
    const detail = (await readDetail()).json();
    expect(detail.journals.find((journal: Journal) => journal.id === before.id)).toMatchObject({ canEdit: true, canDelete: true });

    const deleted = await send({ type: 'deleteJournal', issueId: 1001, operationId: 'admin-delete-with-change', input: {
      journalId: before.id, expectedNotes: before.notes,
    } });
    expect(deleted.statusCode).toBe(200);
    expect(await app.backend.store.getJournals(1001)).toContainEqual({ ...before, notes: '' });
    const after = (await readDetail()).json().journals.find((journal: Journal) => journal.id === before.id);
    expect(after).toMatchObject({ notes: '', changes: before.changes, canEdit: false, canDelete: false, canLike: false });
  });

  it('sets a like to the requested state idempotently across distinct operation IDs', async () => {
    const setLiked: Command = { type: 'setJournalLike', issueId: 1001, operationId: 'like-one', input: { journalId: 9002, liked: true } };
    expect((await send(setLiked)).statusCode).toBe(200);
    expect((await send(setLiked)).statusCode).toBe(200);
    expect((await send({ ...setLiked, operationId: 'like-retried', input: { ...setLiked.input } })).statusCode).toBe(200);
    let comment = (await readDetail()).json().journals.find((journal: Journal) => journal.id === 9002);
    expect(comment).toMatchObject({ likes: 1, likedByMe: true });

    expect((await send({ ...setLiked, operationId: 'unlike-one', input: { journalId: 9002, liked: false } })).statusCode).toBe(200);
    expect((await send({ ...setLiked, operationId: 'unlike-retried', input: { journalId: 9002, liked: false } })).statusCode).toBe(200);
    comment = (await readDetail()).json().journals.find((journal: Journal) => journal.id === 9002);
    expect(comment).toMatchObject({ likes: 0, likedByMe: false });
  });

  it('keeps journal IDs monotonic after deleting the newest comment and rejects cross-issue references', async () => {
    const first = await send({ type: 'comment', issueId: 1001, input: { notes: 'Newest comment' } });
    expect(first.statusCode).toBe(200);
    const newest = (await app.backend.store.getJournals(1001)).find(journal => journal.notes === 'Newest comment')!;
    const wrongIssue = await send({ type: 'deleteJournal', issueId: 1004, input: { journalId: newest.id, expectedNotes: newest.notes } });
    expect(wrongIssue.statusCode).toBe(404);
    expect(wrongIssue.json().code).toBe('JOURNAL_NOT_FOUND');

    const removed = await send({ type: 'deleteJournal', issueId: 1001, input: { journalId: newest.id, expectedNotes: newest.notes } });
    expect(removed.statusCode).toBe(200);
    const next = await send({ type: 'comment', issueId: 1001, input: { notes: 'After deletion' } });
    expect(next.statusCode).toBe(200);
    const nextJournal = (await app.backend.store.getJournals(1001)).find(journal => journal.notes === 'After deletion')!;
    expect(nextJournal.id).toBeGreaterThan(newest.id);
  });

  it('reports demo-only journal features honestly in real mode and blocks writes before network access', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('unavailable', { status: 503 }));
    const real = await createApp({ env: { APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'test-only' },
      databasePath: ':memory:', startWorker: false, fetcher });
    try {
      const bootstrap = (await real.inject('/api/bootstrap')).json();
      expect(bootstrap.capabilities).toMatchObject({ canWrite: false, journalEditing: false, journalDeleting: false, journalLikes: false });
      const requestCountAfterRead = fetcher.mock.calls.length;
      for (const type of ['editJournal', 'deleteJournal', 'setJournalLike']) {
        const response = await real.inject({ method: 'POST', url: '/api/commands', payload: { type, issueId: 1, input: {} } });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('READ_ONLY');
      }
      expect(fetcher).toHaveBeenCalledTimes(requestCountAfterRead);
      expect(fetcher.mock.calls.every(([, init]) => ['GET', 'HEAD', undefined].includes(init?.method as string | undefined))).toBe(true);
    } finally { await real.close(); }
  });

  it('retains deleted IDs from older databases before the first sequence allocation', async () => {
    const legacy: Journal = { id: 50000, user: { id: 1, name: 'Демо користувач' }, notes: 'Existing note before upgrade',
      createdOn: new Date().toISOString(), changes: [] };
    await app.backend.store.saveJournal(1004, legacy);
    expect((await send({ type: 'deleteJournal', issueId: 1004,
      input: { journalId: legacy.id, expectedNotes: legacy.notes } })).statusCode).toBe(200);
    expect((await send({ type: 'comment', issueId: 1004, input: { notes: 'First note after upgrade' } })).statusCode).toBe(200);
    const created = (await app.backend.store.getJournals(1004)).find(item => item.notes === 'First note after upgrade')!;
    expect(created.id).toBeGreaterThan(legacy.id);
  });
});
