/**
 * `previewRestHeaders`: what the Headers tab lists before a send, built from the same rows the send
 * merges, plus the transport's own headers and a credential's handshake.
 */
import { describe, expect, it } from 'vitest';
import { CookieJar, jarCookieHost } from '../../../src/rest/cookie-jar.js';
import { previewRestHeaders } from '../../../src/rest/header-preview.js';
import { entry } from '../../../src/rest/model.js';
import type { RestSendInput } from '../../../src/rest/send.js';

type Overrides = Omit<Partial<RestSendInput>, 'request'> & { readonly request?: Partial<RestSendInput['request']> };

function input(overrides: Overrides = {}): RestSendInput {
  const { request, ...rest } = overrides;
  return {
    baseUrl: 'https://api.test:8443',
    request: {
      method: 'GET',
      url: '/pets',
      pathParams: [],
      query: [],
      headers: [],
      body: { kind: 'none' },
      ...request,
    },
    settings: { timeoutMs: 1_000, followRedirects: true },
    ...rest,
  };
}

const view = (rows: Awaited<ReturnType<typeof previewRestHeaders>>): string[][] =>
  rows.map((row) => [row.name, row.value, row.source, row.state]);

describe('previewRestHeaders', () => {
  it('lists the preferences, the body type, the typed rows and the transport headers', async () => {
    const rows = await previewRestHeaders(
      input({
        defaultHeaders: { 'User-Agent': 'wb/1' },
        request: {
          method: 'POST',
          headers: [entry('X-Trace', '1')],
          body: { kind: 'raw', language: 'json', text: '{}' },
        },
      }),
    );
    expect(view(rows)).toEqual([
      ['User-Agent', 'wb/1', 'preference', 'sent'],
      ['Content-Type', 'application/json', 'body', 'sent'],
      ['X-Trace', '1', 'typed', 'sent'],
      ['Host', 'api.test:8443', 'transport', 'sent'],
      ['Content-Length', '2', 'transport', 'sent'],
    ]);
  });

  it('shows a bearer or API key header as auth, and a preemptive Basic one the transport would add', async () => {
    expect(view(await previewRestHeaders(input({ auth: { type: 'bearer', token: 't' } })))[0]).toEqual([
      'Authorization',
      'Bearer t',
      'auth',
      'sent',
    ]);
    expect(
      view(await previewRestHeaders(input({ auth: { type: 'api-key', name: 'X-Key', value: 'k', in: 'header' } })))[0],
    ).toEqual(['X-Key', 'k', 'auth', 'sent']);
    const basic = await previewRestHeaders(
      input({
        auth: { type: 'basic', username: 'u', password: 'p', preemptive: true },
        settings: { timeoutMs: 1, followRedirects: true, omitHeaders: ['authorization'] },
      }),
    );
    expect(view(basic)[0]).toEqual(['Authorization', 'Basic dTpw', 'auth', 'omitted']);
  });

  it('shows a challenge-based credential as a handshake row, overridden by a typed Authorization', async () => {
    const ntlm = await previewRestHeaders(input({ auth: { type: 'ntlm', username: 'u', password: 'p' } }));
    expect(view(ntlm)[0]).toEqual(['Authorization', 'NTLM', 'handshake', 'sent']);
    const typed = await previewRestHeaders(
      input({
        auth: { type: 'basic', username: 'u', password: 'p', preemptive: false },
        request: { headers: [entry('Authorization', 'Bearer x')] },
      }),
    );
    expect(view(typed)[0]).toEqual(['Authorization', 'Basic', 'handshake', 'overridden']);
  });

  it('reads the jar for the composed URL when the send would, and says when a typed Cookie merges in', async () => {
    const jar = new CookieJar();
    jar.store('https://api.test:8443/', [{ name: 'sid', value: '1' }], Date.now());
    const host = jarCookieHost(jar);
    const cookieRow = async (overrides: Overrides): Promise<string[] | undefined> =>
      view(await previewRestHeaders(input(overrides))).find((row) => row[0] === 'Cookie' && row[2] === 'cookie');

    expect(await cookieRow({ jar: { host, send: true } })).toEqual(['Cookie', 'sid=1', 'cookie', 'sent']);
    expect(await cookieRow({ jar: { host, send: false } })).toBeUndefined();
    expect(
      await cookieRow({
        jar: { host, send: true },
        request: { headers: [entry('Cookie', 'a=2')] },
      }),
    ).toEqual(['Cookie', 'sid=1', 'cookie', 'merged']);
    expect(
      await cookieRow({
        jar: { host, send: true },
        settings: { timeoutMs: 1, followRedirects: true, omitHeaders: ['Cookie'] },
      }),
    ).toEqual(['Cookie', 'sid=1', 'cookie', 'omitted']);
  });

  it('leaves the host out while the URL is incomplete, and the length out when a file cannot be read', async () => {
    const rows = await previewRestHeaders(
      input({
        baseUrl: '',
        request: {
          method: 'POST',
          url: '${base}/x',
          body: { kind: 'binary', source: { kind: 'path', path: 'gone.bin' }, contentType: 'image/png' },
        },
        resolveFile: () => Promise.reject(new Error('missing')),
      }),
    );
    expect(view(rows)).toEqual([['Content-Type', 'image/png', 'body', 'sent']]);
  });
});
