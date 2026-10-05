import { describe, expect, it } from 'vitest';
import { createConfig } from '../src/server/config.js';

describe('explicit runtime write opt-in', () => {
  const base = { APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-only' };
  it.each([undefined, '', 'false', '1', 'yes', 'TRUE', ' true '])('keeps real mode read-only for %s', flag => {
    expect(createConfig({ ...base, REDMINE_WRITE_ENABLED: flag }).writeEnabled).toBe(false);
  });
  it('enables only explicit real opt-in and retains instance data scope', () => {
    const off = createConfig(base);
    const on = createConfig({ ...base, REDMINE_WRITE_ENABLED: 'true' });
    expect(on.writeEnabled).toBe(true);
    expect(on.scope).toBe(off.scope);
  });
  it('never turns demo into a real writer', () => {
    expect(createConfig({ ...base, APP_MODE: 'demo', REDMINE_WRITE_ENABLED: 'true' }).writeEnabled).toBe(false);
    expect(createConfig({ APP_MODE: 'auto', REDMINE_WRITE_ENABLED: 'true' }).mode).toBe('demo');
  });
});
