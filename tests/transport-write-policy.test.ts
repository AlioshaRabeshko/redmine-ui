import { describe, expect, it, vi } from 'vitest';
import { createConfig } from '../src/server/config.js';
import { ReadOnlyError, RedmineRequestError, RedmineTransport } from '../src/server/redmine/transport.js';

const token = 'mock-write-token-never-real';
const config = (write = false) => createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid/team',
  REDMINE_API_TOKEN: token, REDMINE_WRITE_ENABLED: write ? 'true' : 'false' });

describe('Redmine transport write policy', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE'])('rejects %s before fetch when write mode is off', async method => {
    const fetcher = vi.fn();
    const transport = new RedmineTransport(config(), fetcher);
    const init = method === 'DELETE' ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: '{}' };
    await expect(transport.request('issues/123.json', init)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows only JSON writes after explicit opt-in and treats 204 as success', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init! });
      return new Response(null, { status: 204 });
    });
    const transport = new RedmineTransport(config(true), fetcher);
    await expect(transport.request('issues/123.json', { method: 'PUT', body: JSON.stringify({ issue: { notes: 'hi' } }) })).resolves.toBeUndefined();
    await expect(transport.request('versions/2.json', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(calls.map(call => [call.init.method, call.url.pathname])).toEqual([
      ['PUT', '/team/issues/123.json'], ['DELETE', '/team/versions/2.json'],
    ]);
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(calls[0]!.init.headers).get('X-Redmine-API-Key')).toBe(token);
    expect(calls.every(call => call.init.redirect === 'error')).toBe(true);
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it('rejects unsupported bodies, methods, and escaped paths without contacting Redmine', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = new RedmineTransport(config(true), fetcher);
    await expect(transport.request('issues.json', { method: 'POST', body: '{}' })).resolves.toBeUndefined();
    fetcher.mockClear();
    await expect(transport.request('issues.json', { method: 'POST', body: new URLSearchParams({ issue: '{}' }) })).rejects.toThrow('лише JSON');
    await expect(transport.request('issues.json', { method: 'POST', body: '{bad' })).rejects.toThrow('коректним JSON');
    await expect(transport.request('issues.json', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).rejects.toThrow('application/json');
    await expect(transport.request('issues.json', { method: 'GET', body: '{}' })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(transport.request('issues.json', { method: 'DELETE', body: '{}' })).rejects.toThrow('без тіла');
    await expect(transport.request('issues/123/edit', { method: 'POST', body: '{}' })).rejects.toThrow('REST JSON');
    await expect(transport.request('../issues.json', { method: 'DELETE' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns safe validation messages without exposing raw response fields or the API key', async () => {
    const raw = JSON.stringify({ errors: ['Subject cannot be blank', `Sensitive ${token}`], api_key: token, debug: `Raw ${token}` });
    const fetcher = vi.fn(async () => new Response(raw, { status: 422, headers: { 'Content-Type': 'application/json' } }));
    const transport = new RedmineTransport(config(true), fetcher);
    await expect(transport.request('issues.json', { method: 'POST', body: JSON.stringify({ issue: {} }) }))
      .rejects.toMatchObject({ statusCode: 422, validationErrors: ['Subject cannot be blank', 'Sensitive [redacted]'], outcomeUnknown: false });
    try {
      await transport.request('issues.json', { method: 'POST', body: JSON.stringify({ issue: {} }) });
      expect.fail('expected a validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RedmineRequestError);
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain('debug');
    }
  });

  it('does not retry writes after timeouts or follow redirects', async () => {
    const timedOut = vi.fn(async () => { const error = new Error('private network details'); error.name = 'TimeoutError'; throw error; });
    const transport = new RedmineTransport(config(true), timedOut);
    await expect(transport.request('issues.json', { method: 'POST', body: JSON.stringify({ issue: { subject: 'x' } }) }))
      .rejects.toMatchObject({ outcomeUnknown: true, statusCode: undefined });
    expect(timedOut).toHaveBeenCalledTimes(1);

    const redirected = vi.fn(async () => new Response('', { status: 302, headers: { Location: 'https://attacker.invalid/' } }));
    await expect(new RedmineTransport(config(true), redirected).request('issues/1.json', { method: 'PUT', body: JSON.stringify({ issue: { subject: 'x' } }) }))
      .rejects.toMatchObject({ statusCode: 302, outcomeUnknown: true });
    expect(redirected).toHaveBeenCalledTimes(1);
  });

  it('marks a malformed successful POST response as uncertain and accepts empty update responses', async () => {
    const responses = [new Response('', { status: 201 }), new Response('updated', { status: 200 })];
    const fetcher = vi.fn(async () => responses.shift()!);
    const transport = new RedmineTransport(config(true), fetcher);
    await expect(transport.request('issues.json', { method: 'POST', body: JSON.stringify({ issue: { subject: 'x' } }) }))
      .rejects.toMatchObject({ statusCode: 201, outcomeUnknown: true });
    await expect(transport.requestVoid('issues/1.json', { method: 'PUT', body: JSON.stringify({ issue: { subject: 'x' } }) }))
      .resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// Catalog HTML reads must stay reads even when runtime JSON writes are enabled.
it('does not send writes through redirect-following catalog transport', async () => {
  const fetcher = vi.fn();
  const config = createConfig({ APP_MODE: 'redmine', REDMINE_URL: 'https://redmine.example.invalid', REDMINE_API_TOKEN: 'mock-only', REDMINE_WRITE_ENABLED: 'true' });
  await expect(new RedmineTransport(config, fetcher).requestText('issues/1.json', { method: 'PUT', body: '{}' })).rejects.toBeInstanceOf(ReadOnlyError);
  expect(fetcher).not.toHaveBeenCalled();
});
