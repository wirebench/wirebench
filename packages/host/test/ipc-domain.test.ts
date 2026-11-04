// @vitest-environment node
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerDomainChannels } = await import('../src/ipc/domain.js');
const { ServerClient } = await import('../src/server-client.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: { code: string; message: string; details?: Record<string, unknown> };
    };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://acme.app.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const CLAIM = {
  name: 'wirebench.customer.test',
  state: 'pending',
  records: [
    { type: 'CNAME', name: 'wirebench.customer.test', value: 'custom.app.test' },
    { type: 'TXT', name: '_wirebench.wirebench.customer.test', value: 'wirebench-domain-verification=abc' },
  ],
  lastResult: null,
  checkedAt: null,
};
const CHECKED = {
  ...CLAIM,
  lastResult: { cname: 'ok', txt: 'missing', message: 'There is no TXT record.' },
  checkedAt: '2026-11-04T10:00:00.000Z',
};

function exchange(status: number, body?: unknown, headers: Record<string, string> = {}): HttpExchange {
  const bytes = new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json', ...headers },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

let sent: HttpRequest[];

function register(answer: (request: HttpRequest, path: string) => HttpExchange): void {
  sent = [];
  handlers.clear();
  table.clear();
  registerDomainChannels(table, {
    client: new ServerClient({
      send: (request: HttpRequest) => {
        sent.push(request);
        return Promise.resolve(answer(request, new URL(request.url).pathname));
      },
    }),
    accounts: { tokenFor: () => Promise.resolve(TOKEN), markSignedOut: vi.fn() },
  });
}

describe('domain.* channels (hosted edition spec §23.6)', () => {
  it('calls the four tenant-domain routes with the account token', async () => {
    register((request, path) => {
      if (path === '/api/v1/tenant/domain/check') return exchange(200, CHECKED);
      if (request.method === 'PUT') return exchange(200, CLAIM);
      if (request.method === 'DELETE') return exchange(204);
      return exchange(200, CLAIM);
    });
    expect(await invoke('domain.get', { url: SERVER })).toEqual({ ok: true, value: { domain: CLAIM } });
    expect(await invoke('domain.claim', { url: SERVER, name: 'wirebench.customer.test' })).toEqual({
      ok: true,
      value: { domain: CLAIM },
    });
    expect(await invoke('domain.check', { url: SERVER })).toEqual({ ok: true, value: { domain: CHECKED } });
    expect(await invoke('domain.remove', { url: SERVER })).toEqual({ ok: true, value: { removed: true } });
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/v1/tenant/domain',
      'PUT /api/v1/tenant/domain',
      'POST /api/v1/tenant/domain/check',
      'DELETE /api/v1/tenant/domain',
    ]);
    expect(new TextDecoder().decode(sent[1]!.body)).toBe('{"name":"wirebench.customer.test"}');
    for (const request of sent) expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('answers a tenant with no claim as domain: null', async () => {
    register(() => exchange(200, {}));
    expect(await invoke('domain.get', { url: SERVER })).toEqual({ ok: true, value: { domain: null } });
  });

  it('refuses an answer of the wrong shape', async () => {
    register(() => exchange(200, { ...CLAIM, state: 'held' }));
    expect(await invoke('domain.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'server-bad-response' },
    });
  });

  it('surfaces the self-hosted and feature refusals by their codes', async () => {
    register(() => exchange(404, { code: 'custom-domains-hosted-only', message: 'Hosted only.' }));
    expect(await invoke('domain.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'custom-domains-hosted-only' },
    });
    register(() => exchange(403, { code: 'licensing-feature-required', message: 'Enterprise only.' }));
    expect(await invoke('domain.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'licensing-feature-required' },
    });
  });

  it('carries a 429’s retry-after to the renderer', async () => {
    register(() =>
      exchange(
        429,
        { code: 'custom-domains-check-rate-limited', message: 'Checked less than a minute ago.' },
        { 'retry-after': '42' },
      ),
    );
    expect(await invoke('domain.check', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'custom-domains-check-rate-limited', details: { status: 429, retryAfterMs: 42_000 } },
    });
  });

  it('refuses a claim without a name before calling the server', async () => {
    register(() => exchange(200, CLAIM));
    expect(await invoke('domain.claim', { url: SERVER, name: '' })).toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
    expect(sent).toEqual([]);
  });
});
