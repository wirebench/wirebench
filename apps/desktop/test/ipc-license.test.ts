// @vitest-environment node
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerLicenseChannels } = await import('../src/main/ipc/license.js');
const { ServerClient } = await import('../src/main/server-client.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const STATE = {
  edition: 'team',
  status: 'active',
  seats: { used: 3, limit: 50 },
  features: [],
  licenseId: '01J9ZK3V8Q0000000000000000',
};
const PAYLOAD = {
  id: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  edition: 'team',
  seats: 50,
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
};
/** Well-formed but not really signed: main checks the shape and the payload; only the server verifies. */
const LICENSE = `wbl1.${Buffer.from(JSON.stringify(PAYLOAD)).toString('base64url')}.c2lnbmF0dXJl`;

function exchange(status: number, body?: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

let sent: HttpRequest[];

function register(answer: (request: HttpRequest) => HttpExchange, signedIn = true): void {
  sent = [];
  registerLicenseChannels({
    client: new ServerClient({
      send: (request) => {
        sent.push(request);
        return Promise.resolve(answer(request));
      },
    }),
    accounts: { tokenFor: () => Promise.resolve(signedIn ? TOKEN : undefined), markSignedOut: vi.fn() },
  });
}

describe('license.* channels (licensing spec §3.8, §5.3)', () => {
  beforeEach(() => handlers.clear());

  it('reads, installs and removes on /api/v1/license with the account token', async () => {
    register((request) => (request.method === 'DELETE' ? exchange(204) : exchange(200, STATE)));
    expect(await invoke('license.get', { url: SERVER })).toEqual({ ok: true, value: STATE });
    expect(await invoke('license.install', { url: SERVER, license: `${LICENSE}\n` })).toEqual({
      ok: true,
      value: STATE,
    });
    expect(await invoke('license.remove', { url: SERVER })).toEqual({ ok: true, value: { removed: true } });
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/v1/license',
      'PUT /api/v1/license',
      'DELETE /api/v1/license',
    ]);
    expect(new TextDecoder().decode(sent[1]!.body)).toBe(JSON.stringify({ license: LICENSE }));
    for (const request of sent) expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('passes the server’s refusal through with its message', async () => {
    register(() => exchange(400, { code: 'licensing-invalid', message: 'The license signature does not match.' }));
    expect(await invoke('license.install', { url: SERVER, license: LICENSE })).toMatchObject({
      ok: false,
      error: { code: 'licensing-invalid', message: 'The license signature does not match.' },
    });
  });

  it('checks the line and its payload against the shared schema before anything is sent (§3.8)', async () => {
    register(() => exchange(200, STATE));
    const unknownKey = `wbl1.${Buffer.from(JSON.stringify({ ...PAYLOAD, serverId: 'x' })).toString('base64url')}.c2ln`;
    for (const license of ['', 'hello', 'wbl1.a.b', unknownKey]) {
      expect(await invoke('license.install', { url: SERVER, license })).toMatchObject({ ok: false });
    }
    expect(await invoke('license.install', { url: SERVER, license: 'wbl1.a.b' })).toMatchObject({
      ok: false,
      error: { code: 'licensing-invalid' },
    });
    expect(sent).toEqual([]);
  });

  it('asks for a sign-in when signed out', async () => {
    register(() => exchange(200, STATE), false);
    expect(await invoke('license.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'account-signed-out' },
    });
  });
});
