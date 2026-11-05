// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { registerServerSettingsChannels, exportFileName } = await import('../src/ipc/server-settings.js');
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

const section = (value: Record<string, unknown> | null, writable = true) => ({
  source: 'tenant',
  writable,
  value,
  ...(value !== null ? { updatedAt: '2026-11-04T10:00:00.000Z' } : {}),
});
const VIEW = {
  source: 'tenant',
  sections: {
    oidc: section({
      issuer: 'https://login.acme.test',
      clientId: 'wirebench',
      scopes: ['openid', 'email', 'profile'],
      displayName: 'Acme SSO',
      clientSecret: { set: true },
    }),
    saml: section(null),
    auditForward: section(null),
    smtp: section(null),
    retention: section(null),
    budgets: section(null, false),
  },
};
const BILLING = {
  slug: 'acme',
  name: 'Acme Ltd',
  activeMembers: 12,
  edition: 'team',
  editionSource: 'subscription',
  status: 'active',
  suspendedReason: null,
  subscription: {
    plan: 'team',
    seats: 15,
    status: 'past_due',
    currentPeriodEnd: '2026-11-30T00:00:00.000Z',
    pastDueSince: '2026-11-04T10:00:00.000Z',
    pastDueDaysLeft: 11,
  },
  deletion: null,
};
const EXPORT = {
  id: 'f0a1b2c3-0000-4000-8000-000000000001',
  status: 'ready',
  requestedBy: 'Dana Ruiz',
  sizeBytes: 5,
  sha256: 'ab'.repeat(32),
  error: null,
  requestedAt: '2026-11-05T09:12:00.000Z',
  readyAt: '2026-11-05T09:14:00.000Z',
  expiresAt: '2026-11-12T09:14:00.000Z',
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

/** A fake server's answer to a streamed download: the status, and the chunks it sends on a 2xx. */
function streamed(request: HttpRequest, status: number, chunks: readonly Uint8Array[], body?: unknown): HttpExchange {
  const sink = request.stream?.accept(status, {});
  if (sink !== undefined) {
    for (const chunk of chunks) sink.onChunk(chunk);
    return { ...exchange(status), body: new Uint8Array(), streamEnd: { by: 'server' } } as unknown as HttpExchange;
  }
  return exchange(status, body);
}

let sent: HttpRequest[];
const pickSaveFile = vi.fn<() => Promise<string | undefined>>();

function register(answer: (request: HttpRequest, path: string) => HttpExchange): void {
  sent = [];
  handlers.clear();
  table.clear();
  registerServerSettingsChannels(table, {
    client: new ServerClient({
      send: (request: HttpRequest) => {
        sent.push(request);
        return Promise.resolve(answer(request, new URL(request.url).pathname));
      },
    }),
    accounts: { tokenFor: () => Promise.resolve(TOKEN), markSignedOut: vi.fn() },
    picks: {} as never,
    dialogs: { pickSaveFile: (...args: unknown[]) => pickSaveFile(...(args as [])) },
    now: () => new Date('2026-11-05T09:20:00.000Z'),
  });
}

const route = (request: HttpRequest): string => `${request.method} ${new URL(request.url).pathname}`;

describe('serverSettings.* (hosted edition spec §22.12)', () => {
  it('reads, saves and clears a section on the tenant settings routes, with the account token', async () => {
    register(() => exchange(200, VIEW));
    expect(await invoke('serverSettings.get', { url: SERVER })).toEqual({ ok: true, value: VIEW });
    const value = { issuer: 'https://login.acme.test', clientId: 'wirebench', clientSecret: 'typed' };
    expect(await invoke('serverSettings.save', { url: SERVER, section: 'oidc', value })).toEqual({
      ok: true,
      value: VIEW,
    });
    expect(await invoke('serverSettings.clear', { url: SERVER, section: 'saml' })).toEqual({ ok: true, value: VIEW });
    expect(sent.map(route)).toEqual([
      'GET /api/v1/tenant/settings',
      'PUT /api/v1/tenant/settings/oidc',
      'DELETE /api/v1/tenant/settings/saml',
    ]);
    expect(JSON.parse(new TextDecoder().decode(sent[1]!.body))).toEqual(value);
    for (const request of sent) {
      expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(request.url).not.toContain(TOKEN);
    }
  });

  it('refuses budgets, the operator’s section, before calling the server', async () => {
    register(() => exchange(200, VIEW));
    expect(await invoke('serverSettings.save', { url: SERVER, section: 'budgets', value: {} })).toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
    expect(sent).toEqual([]);
  });

  it('surfaces the server’s refusals by their codes', async () => {
    register(() =>
      exchange(400, { code: 'settings-invalid', message: 'The issuer’s discovery document did not answer.' }),
    );
    expect(await invoke('serverSettings.save', { url: SERVER, section: 'oidc', value: {} })).toMatchObject({
      ok: false,
      error: { code: 'settings-invalid', message: 'The issuer’s discovery document did not answer.' },
    });
    register(() => exchange(409, { code: 'settings-environment', message: 'Set by the environment.' }));
    expect(await invoke('serverSettings.clear', { url: SERVER, section: 'smtp' })).toMatchObject({
      ok: false,
      error: { code: 'settings-environment' },
    });
    register(() => exchange(403, { code: 'identity-forbidden', message: 'Server admins only.' }));
    expect(await invoke('serverSettings.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'identity-forbidden' },
    });
  });

  it('refuses an answer of the wrong shape', async () => {
    register(() => exchange(200, { source: 'tenant', sections: {} }));
    expect(await invoke('serverSettings.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'server-bad-response' },
    });
  });
});

describe('tenantBilling.get and tenantDeletion.* (spec §22.11, §22.13)', () => {
  it('reads the billing, and asks for and cancels the deletion with the slug typed', async () => {
    const deletion = { requestedAt: '2026-11-05T09:00:00.000Z', deletingAt: '2026-11-19T09:00:00.000Z' };
    register((request, path) => {
      if (path === '/api/v1/tenant/billing') return exchange(200, BILLING);
      if (request.method === 'POST') return exchange(202, { deletion });
      return exchange(200, { cancelled: true });
    });
    expect(await invoke('tenantBilling.get', { url: SERVER })).toEqual({ ok: true, value: BILLING });
    expect(await invoke('tenantDeletion.request', { url: SERVER, slug: ' acme ' })).toEqual({
      ok: true,
      value: { deletion },
    });
    expect(await invoke('tenantDeletion.cancel', { url: SERVER })).toEqual({ ok: true, value: { cancelled: true } });
    expect(sent.map(route)).toEqual([
      'GET /api/v1/tenant/billing',
      'POST /api/v1/tenant/deletion',
      'DELETE /api/v1/tenant/deletion',
    ]);
    expect(new TextDecoder().decode(sent[1]!.body)).toBe('{"slug":"acme"}');
  });

  it('carries a self-hosted server’s 404 and a wrong slug as their codes', async () => {
    register(() => exchange(404, { code: 'not-found', message: 'Not found.' }));
    expect(await invoke('tenantBilling.get', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'not-found', details: { status: 404 } },
    });
    register(() =>
      exchange(400, { code: 'control-plane-deletion-unconfirmed', message: "type the team's slug to confirm" }),
    );
    expect(await invoke('tenantDeletion.request', { url: SERVER, slug: 'acne' })).toMatchObject({
      ok: false,
      error: { code: 'control-plane-deletion-unconfirmed' },
    });
  });
});

describe('tenantExports.* (spec §22.9)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-export-'));
    pickSaveFile.mockReset();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the exports and asks for one', async () => {
    register((request) =>
      request.method === 'POST' ? exchange(202, { export: EXPORT }) : exchange(200, { exports: [EXPORT] }),
    );
    expect(await invoke('tenantExports.list', { url: SERVER })).toEqual({ ok: true, value: { exports: [EXPORT] } });
    expect(await invoke('tenantExports.request', { url: SERVER })).toEqual({ ok: true, value: { export: EXPORT } });
    expect(sent.map(route)).toEqual(['GET /api/v1/tenant/exports', 'POST /api/v1/tenant/exports']);
  });

  it('streams a ready export into the file main picked, with the token in the header and never the URL', async () => {
    const path = join(dir, 'out.tar.gz');
    pickSaveFile.mockResolvedValue(path);
    register((request) => streamed(request, 200, [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]));
    expect(await invoke('tenantExports.download', { url: SERVER, id: EXPORT.id })).toEqual({
      ok: true,
      value: { saved: true, path, sizeBytes: 5 },
    });
    expect([...(await readFile(path))]).toEqual([1, 2, 3, 4, 5]);
    expect(sent.map(route)).toEqual([`GET /api/v1/tenant/exports/${EXPORT.id}/file`]);
    expect(sent[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.url).not.toContain(TOKEN);
    expect(sent[0]!.url).not.toContain('?');
  });

  it('calls nothing when the picker is cancelled, and leaves no file behind a refusal', async () => {
    pickSaveFile.mockResolvedValue(undefined);
    register(() => exchange(200));
    expect(await invoke('tenantExports.download', { url: SERVER, id: EXPORT.id })).toEqual({
      ok: true,
      value: { saved: false },
    });
    expect(sent).toEqual([]);

    const path = join(dir, 'refused.tar.gz');
    pickSaveFile.mockResolvedValue(path);
    register((request) =>
      streamed(request, 404, [], { code: 'control-plane-export-unknown', message: 'no export has that id' }),
    );
    expect(await invoke('tenantExports.download', { url: SERVER, id: EXPORT.id })).toMatchObject({
      ok: false,
      error: { code: 'control-plane-export-unknown' },
    });
    expect(existsSync(path)).toBe(false);
  });

  it('suggests a file name from the time of the download', () => {
    expect(exportFileName(new Date('2026-11-05T09:20:01.000Z'))).toBe('wirebench-export-20261105T092001Z.tar.gz');
  });
});
