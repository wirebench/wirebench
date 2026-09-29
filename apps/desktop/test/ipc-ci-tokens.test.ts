// apps/desktop/test/ipc-ci-tokens.test.ts
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

const { registerCiTokenChannels } = await import('../src/main/ipc/ci-tokens.js');
const { ServerClient } = await import('../src/main/server-client.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const CI_TOKEN = 'wbs_fake_test_token_000000000000000000000000000';
const WS = '01K000000000000000000000W1';
const ID = '01K000000000000000000000T1';
const SUMMARY = {
  id: ID,
  name: 'pipeline-main',
  createdBy: 'Ada',
  createdAt: '2026-09-29T10:00:00.000Z',
  lastUsedAt: null,
};

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

function register(signedIn = true): void {
  sent = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Promise.resolve(exchange(200, [SUMMARY]));
    if (request.method === 'POST')
      return Promise.resolve(exchange(201, { id: ID, name: 'pipeline-main', token: CI_TOKEN }));
    return Promise.resolve(
      path.endsWith(`/ci-tokens/${ID}`)
        ? exchange(204)
        : exchange(404, { code: 'ci-token-not-found', message: 'That CI token was not found.' }),
    );
  };
  registerCiTokenChannels({
    client: new ServerClient({ send }),
    accounts: { tokenFor: () => Promise.resolve(signedIn ? TOKEN : undefined), markSignedOut: vi.fn() },
  });
}

describe('ciTokens.* channels (callback-assertion §5)', () => {
  beforeEach(() => handlers.clear());

  it('lists, creates and revokes on the workspace’s ci-tokens routes with the account token', async () => {
    register();
    expect(await invoke('ciTokens.list', { url: SERVER, workspaceId: WS })).toEqual({
      ok: true,
      value: { tokens: [SUMMARY] },
    });
    expect(await invoke('ciTokens.create', { url: SERVER, workspaceId: WS, name: 'pipeline-main' })).toEqual({
      ok: true,
      value: { id: ID, name: 'pipeline-main', token: CI_TOKEN },
    });
    expect(await invoke('ciTokens.revoke', { url: SERVER, workspaceId: WS, tokenId: ID })).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      `GET /api/v1/workspaces/${WS}/ci-tokens`,
      `POST /api/v1/workspaces/${WS}/ci-tokens`,
      `DELETE /api/v1/workspaces/${WS}/ci-tokens/${ID}`,
    ]);
    expect(new TextDecoder().decode(sent[1]!.body)).toBe('{"name":"pipeline-main"}');
    for (const request of sent) expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('passes the server’s code through, and asks for a sign-in when signed out', async () => {
    register();
    expect(
      await invoke('ciTokens.revoke', { url: SERVER, workspaceId: WS, tokenId: '01K000000000000000000000T2' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'ci-token-not-found' },
    });
    handlers.clear();
    register(false);
    expect(await invoke('ciTokens.list', { url: SERVER, workspaceId: WS })).toMatchObject({
      ok: false,
      error: { code: 'account-signed-out' },
    });
  });
});
