// apps/desktop/test/ipc-provisioning.test.ts
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

const { registerProvisioningChannels } = await import('../src/main/ipc/provisioning.js');
const { ServerClient } = await import('../src/main/server-client.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const SCIM_TOKEN = `wbscim_${'A'.repeat(43)}`;
const ID = '01K000000000000000000000T1';
const GROUP = '01K000000000000000000000G1';
const TEAM = '01K000000000000000000000M1';
const INFO = {
  configured: true,
  idpEntityId: 'https://idp.example.test/saml',
  entityId: `${SERVER}/api/v1/auth/saml/metadata`,
  acsUrl: `${SERVER}/api/v1/auth/saml/acs`,
  scimBaseUrl: `${SERVER}/scim/v2`,
};
const SUMMARY = { id: ID, name: 'Entra ID', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null };
const LINKED = { id: GROUP, displayName: 'Engineering', memberCount: 2, team: { id: TEAM, name: 'Payments' } };

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

function register(answer: (request: HttpRequest, path: string) => HttpExchange): void {
  sent = [];
  registerProvisioningChannels({
    client: new ServerClient({
      send: (request: HttpRequest) => {
        sent.push(request);
        return Promise.resolve(answer(request, new URL(request.url).pathname));
      },
    }),
    accounts: { tokenFor: () => Promise.resolve(TOKEN), markSignedOut: vi.fn() },
  });
}

describe('provisioning.* channels (saml-scim spec §3.7)', () => {
  beforeEach(() => handlers.clear());

  it('calls the SAML info, SCIM token and SCIM group routes with the account token', async () => {
    register((request, path) => {
      if (path === '/api/v1/auth/saml/info') return exchange(200, INFO);
      if (path === '/api/v1/scim-tokens' && request.method === 'GET') return exchange(200, [SUMMARY]);
      if (path === '/api/v1/scim-tokens') return exchange(201, { ...SUMMARY, token: SCIM_TOKEN });
      if (path === `/api/v1/scim-tokens/${ID}`) return exchange(204);
      if (path === '/api/v1/scim-groups') return exchange(200, [LINKED]);
      if (request.method === 'PUT') return exchange(200, LINKED);
      return exchange(200, { ...LINKED, team: null });
    });
    expect(await invoke('provisioning.info', { url: SERVER })).toEqual({ ok: true, value: INFO });
    expect(await invoke('provisioning.listTokens', { url: SERVER })).toEqual({
      ok: true,
      value: { tokens: [SUMMARY] },
    });
    expect(await invoke('provisioning.createToken', { url: SERVER, name: 'Entra ID' })).toEqual({
      ok: true,
      value: { id: ID, name: 'Entra ID', createdAt: SUMMARY.createdAt, token: SCIM_TOKEN },
    });
    expect(await invoke('provisioning.revokeToken', { url: SERVER, tokenId: ID })).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(await invoke('provisioning.listGroups', { url: SERVER })).toEqual({ ok: true, value: { groups: [LINKED] } });
    expect(await invoke('provisioning.linkGroup', { url: SERVER, groupId: GROUP, teamId: TEAM })).toEqual({
      ok: true,
      value: LINKED,
    });
    expect(await invoke('provisioning.linkGroup', { url: SERVER, groupId: GROUP, teamId: null })).toMatchObject({
      ok: true,
      value: { team: null },
    });
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/v1/auth/saml/info',
      'GET /api/v1/scim-tokens',
      'POST /api/v1/scim-tokens',
      `DELETE /api/v1/scim-tokens/${ID}`,
      'GET /api/v1/scim-groups',
      `PUT /api/v1/scim-groups/${GROUP}/team`,
      `DELETE /api/v1/scim-groups/${GROUP}/team`,
    ]);
    expect(new TextDecoder().decode(sent[5]!.body)).toBe(`{"teamId":"${TEAM}"}`);
    for (const request of sent) expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('surfaces licensing-feature-required as its code', async () => {
    register(() => exchange(403, { code: 'licensing-feature-required', message: 'This needs an Enterprise license.' }));
    expect(await invoke('provisioning.listTokens', { url: SERVER })).toMatchObject({
      ok: false,
      error: { code: 'licensing-feature-required' },
    });
  });
});
