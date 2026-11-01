/**
 * The server host's calls to this server (hosted edition spec §17.3) carry its tenant's `Host` (§19.5), so that in
 * hosted mode they resolve to the same tenant; a `Host` the host sets itself never reaches the routes.
 */
import type { HttpRequest } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { injectSend } from '../../../src/host/inject-send.js';

function fakeApp() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const app = {
    inject: (options: { url: string; headers: Record<string, string> }) => {
      calls.push({ url: options.url, headers: options.headers });
      return Promise.resolve({
        statusCode: 200,
        statusMessage: 'OK',
        headers: {},
        rawPayload: Buffer.alloc(0),
        body: '',
      });
    },
  };
  return { app: app as never, calls };
}

const session = () => ({ token: 'wbd_token', tokenId: 'T1' });
const get = (url: string, headers: Record<string, string> = {}): HttpRequest =>
  ({ method: 'GET', url, headers }) as HttpRequest;

describe('injectSend', () => {
  it('sends each tenant’s calls with that tenant’s Host, whatever Host the host set', async () => {
    for (const serverUrl of ['https://acme.example.test', 'https://globex.example.test']) {
      const { app, calls } = fakeApp();
      const send = injectSend(app, serverUrl, session, () => undefined);
      await send(get(`${serverUrl}/api/v1/me?x=1`, { Host: 'evil.example.test', 'X-Forwarded-Host': 'evil.test' }));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('/api/v1/me?x=1');
      expect(calls[0]!.headers.host).toBe(new URL(serverUrl).host);
      expect(calls[0]!.headers['x-forwarded-host']).toBeUndefined();
      expect(calls[0]!.headers.authorization).toBe('Bearer wbd_token');
    }
  });

  it('refuses a URL of another tenant', async () => {
    const { app, calls } = fakeApp();
    const send = injectSend(app, 'https://acme.example.test', session, () => undefined);
    await expect(send(get('https://globex.example.test/api/v1/me'))).rejects.toMatchObject({
      code: 'server-url-invalid',
    });
    expect(calls).toEqual([]);
  });
});
