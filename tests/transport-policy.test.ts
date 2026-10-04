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
  it('allows bounded raster reads only when bytes match PNG, JPEG, GIF, or WebP signatures', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const fetcher = vi.fn(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
    const transport = new RedmineTransport(config(), fetcher);
    const raster = await transport.requestRaster('attachments/download/123');
    expect(raster.contentType).toBe('image/png');
    expect(raster.data).toEqual(png);
    const call = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].pathname).toBe('/team/attachments/download/123');
    expect(new Headers(call[1].headers).get('X-Redmine-API-Key')).toBe(token);
  });
  it.each([
    ['text/html', '<html><body>login</body></html>'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
  ])('rejects active or non-raster response bodies declared as %s', async (contentType, body) => {
    const fetcher = vi.fn(async () => new Response(body, { headers: { 'Content-Type': contentType } }));
    await expect(new RedmineTransport(config(), fetcher).requestRaster('attachments/download/123')).rejects.toMatchObject({ statusCode: 415 });
  });
  it('rejects oversized image bodies and any off-origin binary path before fetching', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetcher = vi.fn(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
    const transport = new RedmineTransport(config(), fetcher);
    await expect(transport.requestRaster('attachments/download/123', 10)).rejects.toMatchObject({ statusCode: 413 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(transport.requestRaster('https://attacker.invalid/attachments/download/123')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('enforces the same GET-only gate on HTML catalog reads', async () => {
    const fetcher = vi.fn();
    await expect(new RedmineTransport(config(), fetcher).requestText('issues/123/edit', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('follows bounded same-origin redirects for HTML catalog reads and keeps auth on the configured host', async () => {
    const calls: { url: URL; headers: Headers }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith('/issues/123/edit')) return new Response('', { status: 302, headers: { Location: '/team/login' } });
      return new Response('<form><input name="issue[custom_field_values][41][]" value="606"></form>', { headers: { 'Content-Type': 'text/html' } });
    });
    const text = await new RedmineTransport(config(), fetcher).requestText('issues/123/edit');
    expect(text).toContain('custom_field_values');
    expect(calls.map(call => call.url.pathname)).toEqual(['/team/issues/123/edit', '/team/login']);
    expect(calls.every(call => call.url.origin === 'https://redmine.example.invalid')).toBe(true);
    expect(calls.every(call => call.headers.get('X-Redmine-API-Key') === token)).toBe(true);
  });
  it('rejects off-origin HTML redirects without making a second request', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { Location: 'https://attacker.invalid/login' } }));
    await expect(new RedmineTransport(config(), fetcher).requestText('issues/123/edit')).rejects.toMatchObject({ statusCode: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops redirect loops and caps same-origin HTML redirects', async () => {
    const loopFetcher = vi.fn(async () => new Response('', { status: 302, headers: { Location: '/team/issues/123/edit' } }));
    await expect(new RedmineTransport(config(), loopFetcher).requestText('issues/123/edit')).rejects.toMatchObject({ statusCode: 302 });
    expect(loopFetcher).toHaveBeenCalledTimes(2);
    const redirectFetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const index = Number(url.pathname.match(/step-(\d+)/)?.[1] ?? 0);
      return new Response('', { status: 302, headers: { Location: `/team/step-${index + 1}` } });
    });
    await expect(new RedmineTransport(config(), redirectFetcher).requestText('step-0')).rejects.toMatchObject({ statusCode: 302 });
    expect(redirectFetcher).toHaveBeenCalledTimes(4);
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
