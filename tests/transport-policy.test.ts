import { describe, expect, it, vi } from 'vitest';
import { createConfig } from '../src/server/config.js';
import { ReadOnlyError, RedmineTransport } from '../src/server/redmine/transport.js';

const token = 'test-only-secret-never-real';
const config = () => createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid/team', REDMINE_API_TOKEN: token });

describe('independent external mutation policy', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'post', ' put '])('rejects %s before issuing ANY request', async method => {
    const fetcher = vi.fn();
    const transport = new RedmineTransport(config(), fetcher);
    await expect(transport.request('issues/123.json', { method })).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cannot smuggle a write body through an allowed method', async () => {
    const fetcher = vi.fn();
    const transport = new RedmineTransport(config(), fetcher);
    await expect(transport.request('issues/123.json', { method: 'GET', body: '{}' })).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.invalid/issues.json', '//attacker.invalid/issues.json', '../issues.json', '%2e%2e/issues.json', '/issues.json', 'issues\\123.json'])('refuses origin/path escape %s', async path => {
    const fetcher = vi.fn();
    await expect(new RedmineTransport(config(), fetcher).request(path)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('injects auth only into a same-origin read and refuses redirects', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const transport = new RedmineTransport(config(), fetcher);
    await expect(transport.request('issues.json?limit=1')).resolves.toEqual({ issues: [] });
    const call = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].toString()).toBe('https://redmine.example.invalid/team/issues.json?limit=1');
    expect(call[1].method).toBe('GET');
    expect(call[1].redirect).toBe('error');
    expect(new Headers(call[1].headers).get('X-Redmine-API-Key')).toBe(token);
  });
  it('never returns a secret or raw API body in error messages', async () => {
    const transport = new RedmineTransport(config(), async () => new Response(JSON.stringify({ api_key: token }), { status: 401 }));
    try { await transport.request('users/current.json'); expect.fail('should reject'); }
    catch (error) { expect(String(error)).not.toContain(token); expect(String(error)).toContain('401'); }
    const failedNetwork = new RedmineTransport(config(), async () => { throw new Error(`Network diagnostic ${token}`); });
    await expect(failedNetwork.request('users/current.json')).rejects.not.toThrow(token);
  });
  it('explicit demo remains isolated even when a token is configured', () => {
    expect(createConfig({ APP_MODE: 'demo', REDMINE_API_TOKEN: token }).mode).toBe('demo');
    expect(createConfig({ APP_MODE: 'auto', REDMINE_API_TOKEN: token }).mode).toBe('redmine');
    expect(createConfig({ APP_MODE: 'redmine' }).mode).toBe('redmine');
  });
});
