// @vitest-environment node
/**
 * Signing a webhook item's send in main, end to end against the test server (webhook-signatures
 * §5.2, R1, R7): a fresh send signs with the keychain secret and History records the signing
 * headers as sent; a missing secret refuses the send. History's resend replays the recorded
 * headers byte for byte and never signs again — unless the entry holds none, when it signs fresh;
 * the HTTP Log's resend replays the saved request, so it always signs fresh.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import {
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  verifyWebhook,
} from '@wirebench/engine';
import type { Project, WebhookSigning } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import {
  buildRestHistoryEntry,
  toHistoryEntryWire,
  type HistoryService,
  type RecordRestSendInput,
} from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import { registerLogChannels } from '../src/main/ipc/log.js';
import { toSendDeps, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const SECRET = 'abc123def456ghi789';
const SIGNING: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'standard', toleranceSec: 300 },
  secretRef: 'ref-orders',
};
const SIGNING_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;
const BODY = '{"order":42}';

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

function project(target: string, signing: WebhookSigning = SIGNING): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    webhooks: createWebhookCollection({
      target,
      folders: [
        createWebhookFolder('Orders', {
          id: 'g1',
          signing,
          requests: [
            createRestRequest('Paid', {
              id: 'w1',
              method: 'POST',
              url: '/echo',
              body: { kind: 'raw', language: 'json', text: BODY },
            }),
          ],
        }),
      ],
    }),
  };
}

/** Main's send through the engine over `model` with a keychain of `keychain`, History kept newest first. */
function harness(model: Project, keychain: Record<string, string>) {
  // Held in a box so a test can change the project between a send and its resend.
  const box = { model };
  const asked: string[] = [];
  const secrets = (ref: string) => {
    asked.push(ref);
    return Promise.resolve(keychain[ref]);
  };
  const engine = new EngineService(() => Promise.resolve(undefined));
  const entries: HistoryEntryWire[] = [];
  const history = {
    recordRestSend: (projectId: string, record: RecordRestSendInput) => {
      const wire = toHistoryEntryWire(buildRestHistoryEntry(projectId, record));
      entries.unshift(wire);
      return Promise.resolve(wire);
    },
    get: (id: string) => entries.find((candidate) => candidate.id === id),
  };
  const requestDeps: RequestChannelDeps = {
    project: {
      projectId: () => 'p1',
      restMeta: () => undefined,
      runContextFor: () => ({ project: box.model, projectDir: '/tmp/none', globals: {} }),
      scopesFor: () => ({ project: {}, global: {}, system: {} }),
    } as unknown as RequestChannelDeps['project'],
    history: history as unknown as HistoryService,
    secretsFor: () => secrets,
  };
  const sendDeps = toSendDeps(engine, requestDeps);
  registerHistoryChannels(history as never, {
    project: { projectId: () => 'p1' },
    send: sendDeps,
  });
  registerLogChannels({
    showSecrets: { get: () => false },
    service: engine,
    request: requestDeps,
    picks: { rememberWrite: () => undefined },
    appVersion: '0.0.0-test',
  });
  /** A fresh send of `requestId`, as the editor sends it. */
  const send = (sendId: string, requestId: string) =>
    sendThroughEngine(sendDeps, sendId, requestId, { draft: { kind: 'rest' } });
  return { send, entries, asked, keychain, box };
}

function signingHeadersOf(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  return Object.fromEntries(SIGNING_HEADERS.map((name) => [name, String(headers[name])]));
}

describe('signing a webhook send in main', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('signs a fresh send with the keychain secret, and History records the headers as sent', async () => {
    const { send, entries, asked } = harness(project(server.url), { 'ref-orders': SECRET });

    await send('s1', 'w1');

    expect(asked).toContain('ref-orders');
    const last = server.requests.at(-1)!;
    const pairs = SIGNING_HEADERS.map((name) => [name, String(last.headers[name])] as const);
    expect(verifyWebhook(SIGNING.mode === 'sign' ? SIGNING.scheme : never(), SECRET, pairs, last.body)).toEqual({
      verdict: 'verified',
    });
    const recorded = Object.fromEntries(entries[0]!.request.headers.map((header) => [header.name, header.value]));
    expect(recorded).toMatchObject(signingHeadersOf(last.headers));
  });

  it('refuses the send when the keychain has no secret, and nothing goes out', async () => {
    const { send } = harness(project(server.url), {});
    const before = server.requests.length;

    await expect(send('s2', 'w1')).rejects.toMatchObject({
      code: 'webhook-signing-secret',
    });
    expect(server.requests.length).toBe(before);
  });

  it('refuses a CI-only signing on the desktop rather than send unsigned (R7)', async () => {
    const ciOnly: WebhookSigning = {
      mode: 'sign',
      scheme: { kind: 'standard', toleranceSec: 300 },
      secretEnv: 'ORDERS',
    };
    const { send, asked } = harness(project(server.url, ciOnly), { 'webhook-signing:ORDERS': SECRET });

    await expect(send('s3', 'w1')).rejects.toMatchObject({
      code: 'webhook-signing-secret',
    });
    expect(asked).not.toContain('webhook-signing:ORDERS');
  });

  it('a History resend replays the recorded signing headers byte for byte and never signs again (R1)', async () => {
    const h = harness(project(server.url), { 'ref-orders': SECRET });
    await h.send('s4', 'w1');
    const original = signingHeadersOf(server.requests.at(-1)!.headers);
    // Were the resend signed again, a new message id and this new secret would show.
    h.keychain['ref-orders'] = 'zyx987wvu654tsr321';
    h.asked.length = 0;

    const result = await invoke('history.resendRest', { id: h.entries[0]!.id });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(signingHeadersOf(server.requests.at(-1)!.headers)).toEqual(original);
    expect(h.asked).not.toContain('ref-orders');
  });

  it('an HTTP Log resend replays the saved request, so it signs fresh — never unsigned', async () => {
    const h = harness(project(server.url), { 'ref-orders': SECRET });
    await h.send('s5', 'w1');
    const first = signingHeadersOf(server.requests.at(-1)!.headers);
    h.asked.length = 0;

    const result = await invoke('log.resend', { protocol: 'rest', requestId: 'w1', sendId: 's5' });

    expect(result).toMatchObject({ ok: true, value: { protocol: 'rest', exchange: { http: { status: 200 } } } });
    expect(h.asked).toContain('ref-orders');
    const last = server.requests.at(-1)!;
    const pairs = SIGNING_HEADERS.map((name) => [name, String(last.headers[name])] as const);
    expect(verifyWebhook(SIGNING.mode === 'sign' ? SIGNING.scheme : never(), SECRET, pairs, last.body)).toEqual({
      verdict: 'verified',
    });
    expect(signingHeadersOf(last.headers)['webhook-id']).not.toBe(first['webhook-id']);
  });

  it('a History entry without signing headers, for an item that now signs, is resent signed', async () => {
    const h = harness(project(server.url, { mode: 'none' }), { 'ref-orders': SECRET });
    await h.send('s6', 'w1');
    expect(h.entries[0]!.request.headers.map((header) => header.name.toLowerCase())).not.toContain('webhook-signature');
    h.box.model = project(server.url);

    const result = await invoke('history.resendRest', { id: h.entries[0]!.id });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(h.asked).toContain('ref-orders');
    const last = server.requests.at(-1)!;
    const pairs = SIGNING_HEADERS.map((name) => [name, String(last.headers[name])] as const);
    expect(verifyWebhook(SIGNING.mode === 'sign' ? SIGNING.scheme : never(), SECRET, pairs, last.body)).toEqual({
      verdict: 'verified',
    });
  });
});

function never(): never {
  throw new Error('unreachable');
}
