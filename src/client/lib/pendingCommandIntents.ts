import type { Command } from '../../shared/types';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;
type Intent = { signature: string; operationId: string };

/** Keep a real command's identity until success, including across page reloads. */
export class PendingCommandIntents {
  private readonly fallback = new Map<string, Intent>();
  constructor(private readonly storage?: StorageLike) {}

  claim(scope: string, command: Command): Command {
    const { key, signature } = intentKey(scope, command);
    let previous = this.fallback.get(key);
    try {
      const value = this.storage?.getItem(key);
      if (value) {
        const parsed = JSON.parse(value) as Intent;
        if (parsed.signature === signature && typeof parsed.operationId === 'string') previous = parsed;
      }
    } catch { /* The tab retains the operation ID when browser storage is unavailable. */ }
    const intent = previous?.signature === signature ? previous : { signature, operationId: command.operationId || crypto.randomUUID() };
    this.fallback.set(key, intent);
    try { this.storage?.setItem(key, JSON.stringify(intent)); } catch { /* Preserve the ID in this tab. */ }
    return { ...command, operationId: intent.operationId };
  }

  complete(scope: string, command: Command): void {
    const prefix = `redmine:pending-command:${encodeURIComponent(scope)}:`;
    const keys = new Set([...this.fallback.keys()].filter(key => key.startsWith(prefix)));
    try {
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage?.key?.(index);
        if (key?.startsWith(prefix)) keys.add(key);
      }
    } catch { /* Tab fallback remains available. */ }
    for (const key of keys) {
      if (this.fallback.get(key)?.operationId === command.operationId) this.fallback.delete(key);
      try {
        const value = this.storage?.getItem(key);
        if (value && (JSON.parse(value) as Intent).operationId === command.operationId) this.storage?.removeItem(key);
      } catch { /* A completed server operation remains safe to replay if removal failed. */ }
    }
  }
}

function intentKey(scope: string, command: Command): { key: string; signature: string } {
  const { operationId: _operationId, ...payload } = command;
  const signature = JSON.stringify(canonical(payload));
  let hash = 0xcbf29ce484222325n;
  for (const char of signature) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  return { key: `redmine:pending-command:${encodeURIComponent(scope)}:${hash.toString(16)}`, signature };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
let storage: StorageLike | undefined;
try { storage = typeof window === 'undefined' ? undefined : window.localStorage; } catch { /* unavailable */ }
export const pendingCommandIntents = new PendingCommandIntents(storage);
