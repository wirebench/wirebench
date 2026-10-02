// @vitest-environment node
/**
 * A desktop REST send through the engine's `openExchange` (`sendThroughEngine`): it records a fixed
 * History row and answers a fixed summary, streams live, cancels,
 * logs a prepare failure without History, refuses what nothing resolves, runs scripts, lets a draft's
 * credentials replace the request's own, and resolves `${#Global#…}` from the project's globals.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import {
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  entry,
  verifyWebhook,
} from '@wirebench/engine';
import type { Project, RequestScripts, RestRequestDef, WebhookSigning } from '@wirebench/engine';
import { buildRestHistoryEntry, toHistoryEntryWire, type RecordRestSendInput } from '../src/main/history-service.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { ScriptHost } from '../src/main/script-host.js';
import { recordSecretValue, redactSecretText } from '../src/main/redact.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import type {
  FailedExchangeWire,
  HistoryEntryWire,
  RestExchangeSummary,
  RestLiveEvent,
} from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

/** One `request.*` channel as the renderer invokes it; the reply is the IPC envelope. */
function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

/** Registers the `request.*` channels over `model`, with `extra` laid over the dependencies. */
function registerOver(model: Project, extra: Partial<RequestChannelDeps> = {}): void {
  handlers.clear();
  registerRequestChannels(new EngineService(), {
    project: {
      projectId: () => model.id,
      runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
      restMeta: () => undefined,
      requestMeta: () => undefined,
    } as unknown as RequestChannelDeps['project'],
    ...extra,
  });
}

const KEY = 'good-key-9f3a';
const secrets = (ref: string): Promise<string | undefined> =>
  Promise.resolve(ref === 'sec_key' ? KEY : ref === 'sec_other' ? 'other-key-77' : undefined);

let server: TestRestServer;
let userDataDir: string;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-send-exchange-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/** One API whose key travels in the query, holding `requests` (by default `req-1` at `/echo`). */
function seeded(requests?: readonly RestRequestDef[]): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl: server.url,
    auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' },
    requests: [...(requests ?? [createRestRequest('Echo', { id: 'req-1', url: '/echo', query: [entry('x', '1')] })])],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

async function openHistory(): Promise<HistoryService> {
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  return history;
}

// `x-server-ms` (the test server's own timing) and `date` differ between any two sends, wherever
// the response's head is kept: its headers, and its raw bytes.
const volatile = new Set(['id', 'sendId', 'at', 'startedAt', 'durationMs', 'timings', 'x-server-ms', 'date']);
const steady = (head: string): string =>
  head.replace(/x-server-ms: [^\r\n]*/gi, 'x-server-ms: -').replace(/date: [^\r\n]*/gi, 'date: -');
const normalise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => {
      if (volatile.has(key) || (Array.isArray(inner) && volatile.has(String(inner[0]).toLowerCase()))) {
        return undefined;
      }
      if (typeof inner === 'string' && key.endsWith('Base64')) {
        return steady(Buffer.from(inner, 'base64').toString('latin1'));
      }
      return typeof inner === 'string' ? steady(inner) : inner;
    }),
  );

/** `req-1` sent through the engine, into a real History. */
async function sendNew(model: Project): Promise<{ entry: HistoryEntryWire; summary: RestExchangeSummary }> {
  const appended: HistoryEntryWire[] = [];
  const deps = sendDepsFor(model, {
    history: await openHistory(),
    onHistoryAppended: (wire) => appended.push(wire),
    getSecret: secrets,
  });
  const summary = await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
  return { entry: appended[0]!, summary };
}

/** Waits, with a bounded deadline, until `predicate()` is true — never a fixed sleep. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('sendThroughEngine for a REST request', () => {
  it('records the History row and answers the summary of what went out, the query key masked', async () => {
    const { entry: row, summary } = await sendNew(seeded());
    const host = server.url.replace('http://', '');
    /** The test server's echo of the call, with the key as `key` reads it. */
    const echo = (key: string): string =>
      JSON.stringify({
        method: 'GET',
        path: '/echo',
        query: { x: '1', api_key: key },
        headers: {
          host,
          connection: 'keep-alive',
          'user-agent': 'Wirebench/0.1',
          'accept-encoding': 'gzip, deflate, br',
        },
        body: '',
        contentType: null,
      });
    const length = String(Buffer.byteLength(echo(KEY)));
    const rawHeaders = [
      null,
      ['content-type', 'application/json'],
      ['content-length', length],
      null,
      ['connection', 'keep-alive'],
      ['keep-alive', 'timeout=5'],
    ];
    const url = `${server.url}/echo?x=1&api_key=%3Credacted%3E`;
    expect(normalise(row)).toEqual({
      kind: 'rest',
      projectId: 'p1',
      requestId: 'req-1',
      requestName: 'Echo',
      interfaceName: 'Petstore',
      operationName: '',
      endpoint: url,
      method: 'GET',
      soapVersion: 'none',
      status: 200,
      ok: true,
      request: { envelopeXml: '', headers: [] },
      response: { envelopeXml: echo('<redacted>'), rawHeaders, status: 200, statusText: 'OK' },
      // The response's raw bytes, as the summary carries them (its key masked).
      sizeBytes: Buffer.from(summary.http.rawResponseBase64, 'base64').byteLength,
    });
    expect(normalise(summary)).toEqual({
      http: {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'content-length': length,
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
        },
        rawHeaders,
        bodyBase64: echo(KEY),
        rawBodyBase64: echo(KEY),
        rawRequestBase64: `GET /echo?x=1&api_key=%3Credacted%3E HTTP/1.1\r\nhost: ${host}\r\nUser-Agent: Wirebench/0.1\r\nAccept-Encoding: gzip, deflate, br\r\n\r\n`,
        rawResponseBase64:
          `HTTP/1.1 200 OK\r\nx-server-ms: -\r\ncontent-type: application/json\r\ncontent-length: ${length}\r\n` +
          `date: -\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n${echo('<redacted>')}`,
        truncated: false,
        httpVersion: '1.1',
        redirects: [],
        request: {
          url,
          method: 'GET',
          headers: { 'User-Agent': 'Wirebench/0.1', 'Accept-Encoding': 'gzip, deflate, br' },
        },
        keyNames: { params: ['api_key'], headers: [] },
      },
      url,
      method: 'GET',
      text: echo(KEY),
      language: 'json',
      cookies: [],
      methodChanged: false,
      problems: [],
    });
  });

  it('hands every rest.live event over before the send resolves', async () => {
    const model = seeded([createRestRequest('Ticks', { id: 'req-1', url: '/sse/ticks?n=3&every=5' })]);
    const live: RestLiveEvent[] = [];
    let rowsAtResolve = -1;
    const summary = await sendThroughEngine(sendDepsFor(model, { getSecret: secrets }), 's1', 'req-1', {
      draft: { kind: 'rest' },
      onLive: (event) => live.push(event),
    }).then((sent) => {
      rowsAtResolve = live.filter((event) => event.kind === 'row').length;
      return sent;
    });

    expect(rowsAtResolve).toBe(3);
    expect(live[0]).toMatchObject({ kind: 'open', sendId: 's1', status: 200 });
    expect(live.filter((event) => event.kind === 'row').map((event) => event.row)).toEqual(summary.stream?.rows);
    expect(summary.stream?.endedBy).toBe('server');
  });

  it('ends a stream with endedBy client when the registry cancels it', async () => {
    const model = seeded([createRestRequest('Forever', { id: 'req-1', url: '/sse/forever' })]);
    const deps = sendDepsFor(model, { getSecret: secrets });
    const live: RestLiveEvent[] = [];
    const sending = sendThroughEngine(deps, 's1', 'req-1', {
      draft: { kind: 'rest' },
      onLive: (event) => live.push(event),
    });
    await waitFor(() => live.some((event) => event.kind === 'row'), 'the first row');

    expect(deps.registry.cancel('s1')).toEqual({ cancelled: true });
    const summary = await sending;

    expect(summary.stream?.endedBy).toBe('client');
    expect(deps.registry.has('s1')).toBe(false);
    expect(deps.registry.cancel('s1')).toEqual({ cancelled: false });
  });

  it('writes one prepare row and no History entry when the proxy lookup fails', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    const deps = sendDepsFor(seeded(), {
      getSecret: secrets,
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
      project: { proxyFor: () => Promise.reject(new Error('no proxy today')) },
    });

    await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toThrow('no proxy today');

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stage: 'prepare', protocol: 'rest', requestId: 'req-1' });
    expect(appended).toEqual([]);
  });

  it('History durationMs excludes a slow proxy lookup, on a send that succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const appended: HistoryEntryWire[] = [];
      const deps = sendDepsFor(seeded(), {
        getSecret: secrets,
        history: await openHistory(),
        onHistoryAppended: (wire) => appended.push(wire),
        project: {
          proxyFor: () => {
            vi.setSystemTime(Date.now() + 500);
            return Promise.resolve(undefined);
          },
        },
      });
      await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
      expect(appended).toHaveLength(1);
      expect(appended[0]!.durationMs).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('History durationMs and the send row exclude a slow proxy lookup, on a send that fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const appended: HistoryEntryWire[] = [];
      const failures: FailedExchangeWire[] = [];
      // Nothing listens on port 1: the send fails on the wire, after the proxy lookup.
      const model = seeded();
      const refused: Project = { ...model, apis: model.apis.map((api) => ({ ...api, baseUrl: 'http://127.0.0.1:1' })) };
      const deps = sendDepsFor(refused, {
        getSecret: secrets,
        history: await openHistory(),
        onHistoryAppended: (wire) => appended.push(wire),
        onSendFailed: (failure) => failures.push(failure),
        project: {
          proxyFor: () => {
            vi.setSystemTime(Date.now() + 500);
            return Promise.resolve(undefined);
          },
        },
      });
      await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toThrow();
      expect(appended).toHaveLength(1);
      expect(appended[0]!.durationMs).toBeLessThan(500);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.stage).toBeUndefined();
      expect(failures[0]!.durationMs).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a reference nothing resolves as rest-unresolved-properties', async () => {
    const model = seeded([createRestRequest('Nope', { id: 'req-1', url: '/echo', headers: [entry('x', '${nope}')] })]);
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    const deps = sendDepsFor(model, {
      getSecret: secrets,
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toMatchObject({
      code: 'rest-unresolved-properties',
    });
    // Refused before the wire, as SOAP is: a prepare row with no headers, and no History entry.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      protocol: 'rest',
      requestId: 'req-1',
      stage: 'prepare',
      request: { method: 'GET', headers: {} },
      error: { code: 'rest-unresolved-properties' },
    });
    expect(failures[0]?.request.url).toContain(`${server.url}/echo`);
    expect(appended).toEqual([]);
  });

  it('refuses a credential missing from the keychain before the call: one prepare row, no History', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    const deps = sendDepsFor(seeded(), {
      getSecret: () => Promise.resolve(undefined),
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toMatchObject({
      code: 'secret-missing',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      protocol: 'rest',
      requestId: 'req-1',
      stage: 'prepare',
      request: { method: 'GET', headers: {} },
      error: { code: 'secret-missing' },
    });
    expect(appended).toEqual([]);
  });

  it('refuses a request no project holds as unknown-entity', async () => {
    await expect(
      sendThroughEngine(sendDepsFor(seeded()), 's1', 'nope', { draft: { kind: 'rest' } }),
    ).rejects.toMatchObject({ code: 'unknown-entity', message: 'No REST request with id "nope"' });
  });

  it('resolves ${#Global#…} from the globals the project is run with', async () => {
    const model = seeded([
      createRestRequest('Echo', { id: 'req-1', url: '/echo', headers: [entry('x-region', '${#Global#region}')] }),
    ]);
    const deps = sendDepsFor(model, {
      getSecret: secrets,
      project: { runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: { region: 'eu-2' } }) },
    });

    const summary = await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });

    expect((JSON.parse(summary.text) as { headers: Record<string, string> }).headers['x-region']).toBe('eu-2');
  });

  it("lets a draft's credentials replace the request's own", async () => {
    const summary = await sendThroughEngine(sendDepsFor(seeded(), { getSecret: secrets }), 's1', 'req-1', {
      draft: { kind: 'rest', draft: { auth: { type: 'api-key', name: 'k2', in: 'header', valueRef: 'sec_other' } } },
    });

    const echoed = JSON.parse(summary.text) as { headers: Record<string, string>; query: Record<string, string> };
    expect(echoed.headers['k2']).toBe('other-key-77');
    expect(echoed.query['api_key']).toBeUndefined();
  });
});

describe('sendThroughEngine for a REST request with scripts', () => {
  let host: ScriptHost | undefined;

  afterEach(async () => {
    await host?.dispose();
    host = undefined;
  });

  function scripts(input: { pre?: string; post?: string }): RequestScripts {
    return {
      ...(input.pre !== undefined ? { pre: { text: input.pre } } : {}),
      ...(input.post !== undefined ? { post: { text: input.post } } : {}),
      api: 'wirebench',
      enabled: true,
      secrets: [],
    };
  }

  it('runs them, and keeps the values they set in the session', { timeout: 60_000 }, async () => {
    const request = {
      ...createRestRequest('Echo', { id: 'req-1', url: '/echo' }),
      scripts: scripts({
        pre: "request.headers.set('x-ran', 'yes');",
        post: "vars.set('seen', String(response.status)); test('ok', () => expect(response.status).toBe(200));",
      }),
    };
    const model = seeded([request]);
    host = new ScriptHost({
      modelOf: () => model,
      openApiDocumentFor: () => Promise.reject(new Error('no definition')),
      grpcProtoSetFor: () => Promise.reject(new Error('no definition')),
      soapDefinitionFor: () => undefined,
    });

    const summary = await sendThroughEngine(sendDepsFor(model, { getSecret: secrets, scripts: host }), 's1', 'req-1', {
      draft: { kind: 'rest' },
    });

    expect((JSON.parse(summary.text) as { headers: Record<string, string> }).headers['x-ran']).toBe('yes');
    expect(summary.script?.tests).toEqual([{ name: 'ok', passed: true }]);
    expect(host.sessionValues('p1')).toEqual({ seen: '200' });
  });
});

describe('sendThroughEngine for an orphaned REST request', () => {
  /** `req-1` is a request the API's contract no longer has; a run skips it, a person may send it. */
  function orphaned(): Project {
    return seeded([{ ...createRestRequest('Legacy', { id: 'req-1', url: '/echo' }), orphaned: true }]);
  }

  it('sends it from the editor', async () => {
    const summary = await sendThroughEngine(sendDepsFor(orphaned(), { getSecret: secrets }), 's1', 'req-1', {
      draft: { kind: 'rest' },
    });
    expect(summary.http.status).toBe(200);
  });

  it('exports it as a cURL command', async () => {
    registerOver(orphaned());
    const result = unwrap<{ command: string }>(await invoke('request.curl', { requestId: 'req-1', shell: 'posix' }));
    expect(result.command).toContain(`${server.url}/echo?`);
  });
});

describe('sendThroughEngine for a webhook item', () => {
  const SECRET = 'abc123def456ghi789';
  const SIGNING: WebhookSigning = {
    mode: 'sign',
    scheme: { kind: 'standard', toleranceSec: 300 },
    secretRef: 'ref-orders',
  };
  const SIGNING_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;
  const BODY = '{"order":42}';

  /** Webhook item `w1` under folder `Orders`, `POST /echo` to `target`. */
  function hooks(target: string, signing: WebhookSigning = SIGNING, orphan = false): Project {
    const paid = createRestRequest('Paid', {
      id: 'w1',
      method: 'POST',
      url: '/echo',
      body: { kind: 'raw', language: 'json', text: BODY },
    });
    return {
      ...createProject('P', { id: 'p1' }),
      webhooks: createWebhookCollection({
        target,
        folders: [
          createWebhookFolder('Orders', {
            id: 'g1',
            signing,
            requests: [orphan ? { ...paid, orphaned: true } : paid],
          }),
        ],
      }),
    };
  }

  /** A History that keeps what is recorded, newest first, and answers `newestFor` from `parents`. */
  function history(parents: Record<string, HistoryEntryWire> = {}) {
    const entries: HistoryEntryWire[] = [];
    return {
      entries,
      service: {
        recordRestSend: (projectId: string, record: RecordRestSendInput) => {
          const wire = toHistoryEntryWire(buildRestHistoryEntry(projectId, record));
          entries.unshift(wire);
          return Promise.resolve(wire);
        },
        newestFor: (_projectId: string, requestId: string) => parents[requestId],
      } as unknown as HistoryService,
    };
  }

  function keychain(values: Record<string, string>) {
    const asked: string[] = [];
    return {
      asked,
      secretsFor: () => (ref: string) => {
        asked.push(ref);
        return Promise.resolve(values[ref]);
      },
    };
  }

  const signingHeadersOf = (headers: Readonly<Record<string, string | string[] | undefined>>) =>
    Object.fromEntries(SIGNING_HEADERS.map((name) => [name, String(headers[name])]));

  it('signs with the keychain secret, and History records the signing headers as sent', async () => {
    const kept = history();
    const keys = keychain({ 'ref-orders': SECRET });
    await sendThroughEngine(
      sendDepsFor(hooks(server.url), { history: kept.service, secretsFor: keys.secretsFor }),
      's1',
      'w1',
      { draft: { kind: 'rest' } },
    );

    expect(keys.asked).toContain('ref-orders');
    const last = server.requests.at(-1)!;
    const pairs = SIGNING_HEADERS.map((name) => [name, String(last.headers[name])] as const);
    expect(verifyWebhook(SIGNING.mode === 'sign' ? SIGNING.scheme : never(), SECRET, pairs, last.body)).toEqual({
      verdict: 'verified',
    });
    const recorded = Object.fromEntries(kept.entries[0]!.request.headers.map((header) => [header.name, header.value]));
    expect(recorded).toMatchObject(signingHeadersOf(last.headers));
  });

  it('sends an orphaned webhook item too', async () => {
    const keys = keychain({ 'ref-orders': SECRET });
    const summary = await sendThroughEngine(
      sendDepsFor(hooks(server.url, SIGNING, true), { secretsFor: keys.secretsFor }),
      's1',
      'w1',
      { draft: { kind: 'rest' } },
    );
    expect(summary.http.status).toBe(200);
  });

  it('refuses the send when the keychain has no secret, and nothing goes out', async () => {
    const before = server.requests.length;
    await expect(
      sendThroughEngine(sendDepsFor(hooks(server.url), { secretsFor: keychain({}).secretsFor }), 's2', 'w1', {
        draft: { kind: 'rest' },
      }),
    ).rejects.toMatchObject({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the folder “Orders” but its secret is not set',
    });
    expect(server.requests.length).toBe(before);
  });

  it('refuses a CI-only signing on the desktop rather than send unsigned (R7)', async () => {
    const ciOnly: WebhookSigning = {
      mode: 'sign',
      scheme: { kind: 'standard', toleranceSec: 300 },
      secretEnv: 'ORDERS',
    };
    const keys = keychain({ 'webhook-signing:ORDERS': SECRET });
    const before = server.requests.length;

    await expect(
      sendThroughEngine(sendDepsFor(hooks(server.url, ciOnly), { secretsFor: keys.secretsFor }), 's3', 'w1', {
        draft: { kind: 'rest' },
      }),
    ).rejects.toMatchObject({ code: 'webhook-signing-secret' });
    expect(keys.asked).not.toContain('webhook-signing:ORDERS');
    expect(server.requests.length).toBe(before);
  });

  it('refuses an empty target as webhook-target-missing, sending nothing and writing no row', async () => {
    const failures: FailedExchangeWire[] = [];
    const kept = history();
    const before = server.requests.length;

    await expect(
      sendThroughEngine(
        sendDepsFor(hooks('', { mode: 'none' }), {
          history: kept.service,
          onSendFailed: (failure) => failures.push(failure),
        }),
        's4',
        'w1',
        { draft: { kind: 'rest' } },
      ),
    ).rejects.toMatchObject({ code: 'webhook-target-missing', message: 'Set the Webhooks target' });
    expect(server.requests.length).toBe(before);
    expect(failures).toEqual([]);
    expect(kept.entries).toEqual([]);
  });

  it('sends a callback, through request.sendRest, to exactly the URL its parent recorded', async () => {
    // Already in its encoded form: a query value is percent-encoded on the wire like any send's.
    const callback = `${server.url}/echo?t=abc123&sub=42`;
    const model: Project = {
      ...createProject('P', { id: 'p1' }),
      apis: [
        createApi('Petstore', {
          id: 'api-1',
          baseUrl: 'https://api.test',
          requests: [
            createRestRequest('Subscribe', {
              id: 'parent',
              method: 'POST',
              url: '/subscriptions',
              contract: { method: 'post', path: '/subscriptions' },
            }),
          ],
        }),
      ],
      webhooks: createWebhookCollection({
        folders: [
          createWebhookFolder('Petstore', {
            id: 'g1',
            target: 'http://127.0.0.1:1/never',
            source: { apiId: 'api-1' },
            requests: [
              createRestRequest('onEvent', {
                id: 'w3',
                method: 'POST',
                url: '/onEvent',
                hook: {
                  kind: 'callback',
                  operation: 'post /subscriptions',
                  name: 'onEvent',
                  expression: '{$request.body#/callbackUrl}',
                },
              }),
            ],
          }),
        ],
      }),
    };
    const parent: HistoryEntryWire = {
      id: 'h1',
      kind: 'rest',
      at: '2026-09-28T10:42:00.000Z',
      projectId: 'p1',
      requestId: 'parent',
      requestName: 'Subscribe',
      interfaceName: 'Petstore',
      operationName: '',
      endpoint: 'https://api.test/subscriptions',
      soapVersion: 'none',
      method: 'POST',
      status: 201,
      durationMs: 5,
      ok: true,
      request: { envelopeXml: JSON.stringify({ callbackUrl: callback }), headers: [] },
      response: { envelopeXml: '{}', rawHeaders: [], status: 201, statusText: 'Created' },
      sizeBytes: 0,
    };
    const kept = history({ parent });
    registerOver(model, { history: kept.service });

    const summary = unwrap<RestExchangeSummary>(await invoke('request.sendRest', { sendId: 'cb1', requestId: 'w3' }));

    expect(server.requests.at(-1)!.url).toBe('/echo?t=abc123&sub=42');
    expect(summary.url).toBe(callback);
    expect(kept.entries[0]!.endpoint).toBe(callback);
  });
});

describe('closing a project over a plain REST send in flight', () => {
  it('cancels it, and History records it as aborted', async () => {
    const appended: HistoryEntryWire[] = [];
    const deps = sendDepsFor(seeded([createRestRequest('Slow', { id: 'req-1', url: '/slow?ms=2000' })]), {
      getSecret: secrets,
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
    });
    const sending = sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
    await waitFor(() => deps.registry.has('s1'), 'the send to be kept');

    expect(deps.registry.endWhere(() => true, 'rest')).toBe(1);

    await expect(sending).rejects.toMatchObject({ code: 'aborted' });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ ok: false, error: { code: 'aborted' } });
  });

  it('lets the close wait until the cancelled send has written its History entry', async () => {
    // Any send through the engine — a resend, a sequence step, a multi-environment child — not
    // only the editor's: the History file must not close under its write.
    const history = await openHistory();
    let written = false;
    const record = history.recordRestSend.bind(history);
    vi.spyOn(history, 'recordRestSend').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      written = true;
      return await record(...args);
    });
    const deps = sendDepsFor(seeded([createRestRequest('Slow', { id: 'req-1', url: '/slow?ms=2000' })]), {
      getSecret: secrets,
      history,
    });
    const sending = sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } }).catch(() => undefined);
    await waitFor(() => deps.registry.has('s1'), 'the send to be kept');
    deps.registry.endWhere(() => true, 'rest');

    await deps.registry.whenRecorded(5_000, (requestId) => requestId === 'req-1');

    expect(written).toBe(true);
    await sending;
  });

  it('waits for nothing when no send of a matching request is in flight', async () => {
    const deps = sendDepsFor(seeded([]));
    const started = performance.now();
    await deps.registry.whenRecorded(5_000, () => true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

function never(): never {
  throw new Error('unreachable');
}

describe("request.sendRest — the request's own assertions", () => {
  it('checks them against the answer, and returns the results with it', async () => {
    registerOver(
      seeded([
        {
          ...createRestRequest('Echo', { id: 'req-1', url: '/echo' }),
          assertions: [
            { type: 'status', equals: 200 },
            { type: 'status', equals: 404 },
          ],
        },
      ]),
      { secretsFor: () => secrets },
    );

    const summary = unwrap<RestExchangeSummary>(await invoke('request.sendRest', { sendId: 'a1', requestId: 'req-1' }));

    expect(summary.assertions?.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'passed'],
      ['status', 'failed'],
    ]);
  });

  it('masks every string of a result, so a recorded secret never reaches the pane', async () => {
    const secret = 'assert-secret-7e3f9a';
    recordSecretValue(secret);
    registerOver(
      seeded([
        {
          ...createRestRequest('Echo', { id: 'req-1', url: '/echo' }),
          assertions: [
            { type: 'match', language: 'jsonpath', expression: '$.nothing', equals: secret, name: `wants ${secret}` },
          ],
        },
      ]),
      { secretsFor: () => secrets },
    );

    const summary = unwrap<RestExchangeSummary>(await invoke('request.sendRest', { sendId: 'a2', requestId: 'req-1' }));

    const results = summary.assertions ?? [];
    expect(results).toHaveLength(1);
    const masked = redactSecretText(secret, { show: false });
    expect(masked).not.toContain(secret);
    for (const result of results) {
      for (const text of [result.label, result.expected, result.actual, result.message]) {
        expect(text ?? '').not.toContain(secret);
      }
    }
    expect(JSON.stringify(results)).toContain(masked);
  });
});
