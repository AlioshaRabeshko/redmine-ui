import { describe, expect, it } from 'vitest';
import { PendingCommandIntents } from './pendingCommandIntents';
import type { Command } from '../../shared/types';

function storageFixture() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const command: Command = { type: 'createIssue', projectId: 1, input: { subject: 'Persisted identity', description: 'Draft' } };
describe('real write intent identity', () => {
  it('survives reload and ignores a newly generated submit ID until success', () => {
    const storage = storageFixture();
    const first = new PendingCommandIntents(storage).claim('instance:me', { ...command, operationId: 'first' });
    const afterReload = new PendingCommandIntents(storage);
    expect(afterReload.claim('instance:me', { ...command, operationId: 'second' }).operationId).toBe('first');
    afterReload.complete('instance:me', first);
    expect(afterReload.claim('instance:me', { ...command, operationId: 'third' }).operationId).toBe('third');
  });
  it('isolates users, payloads and instances while canonicalizing field order', () => {
    const registry = new PendingCommandIntents(storageFixture());
    expect(registry.claim('one:me', { ...command, operationId: 'original' }).operationId).toBe('original');
    expect(registry.claim('one:me', { ...command, input: { description: 'Draft', subject: 'Persisted identity' } }).operationId).toBe('original');
    expect(registry.claim('two:me', { ...command, operationId: 'other-instance' }).operationId).toBe('other-instance');
    expect(registry.claim('one:other', { ...command, operationId: 'other-user' }).operationId).toBe('other-user');
    expect(registry.claim('one:me', { ...command, input: { subject: 'Different' }, operationId: 'new-content' }).operationId).toBe('new-content');
  });
  it('clears the original payload when a drawer retry completes after reload', () => {
    const storage = storageFixture();
    new PendingCommandIntents(storage).claim('scope', { ...command, operationId: 'partial' });
    const reloaded = new PendingCommandIntents(storage);
    reloaded.complete('scope', { type: 'createIssue', issueId: 501, input: {}, operationId: 'partial' });
    expect(reloaded.claim('scope', { ...command, operationId: 'new-submit' }).operationId).toBe('new-submit');
  });
  it('keeps the ID in this tab when storage rejects writes', () => {
    const registry = new PendingCommandIntents({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blocked'); } });
    const first = registry.claim('scope', command);
    expect(registry.claim('scope', command).operationId).toBe(first.operationId);
  });
});
