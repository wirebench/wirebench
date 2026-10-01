// @vitest-environment node
/**
 * A desktop REST send through the engine's `openExchange` (`sendThroughEngine`): it records the same
 * History row and answers the same summary as the app's own REST path did, streams live, cancels,
 * logs a prepare failure without History, refuses what nothing resolves, runs scripts, lets a draft's
 * credentials replace the request's own, and resolves `${#Global#…}` from the project's globals.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry, resolveApiBaseUrl } from '@wirebench/engine';
import type { Project, RequestScripts, RestRequestDef } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { sendRestRequest, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { resolveRestSend } from '../src/main/rest-send.js';
import { ScriptHost } from '../src/main/script-host.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import type {
  FailedExchangeWire,
  HistoryEntryWire,
  RestExchangeSummary,
  RestLiveEvent,
} from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

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

/** `req-1` sent through the app's own REST path, into a real History. */
async function sendOld(model: Project): Promise<{ entry: HistoryEntryWire; summary: RestExchangeSummary }> {
  const engine = new EngineService(secrets);
  const appended: HistoryEntryWire[] = [];
  const deps: RequestChannelDeps = {
    project: {
      projectId: () => 'p1',
      restSend: (requestId: string) =>
        resolveRestSend({
          project: model,
          requestId,
          scopes: { project: {}, global: {}, system: {} },
          resolveBaseUrl: (api) => resolveApiBaseUrl(model, undefined, api),
        }),
    } as unknown as RequestChannelDeps['project'],
    history: await openHistory(),
    onHistoryAppended: (wire) => appended.push(wire),
  };
  const summary = await sendRestRequest(engine, deps, { sendId: 's0', requestId: 'req-1' });
  return { entry: appended[0]!, summary };
}

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
  // Task 17 deletes this case with the old path.
  it('records the same History row as the old REST path', async () => {
    const before = await sendOld(seeded());
    const after = await sendNew(seeded());
    expect(normalise(after.entry)).toEqual(normalise(before.entry));
    expect(normalise(after.summary)).toEqual(normalise(before.summary));
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

  it('refuses a reference nothing resolves as rest-unresolved-properties', async () => {
    const model = seeded([createRestRequest('Nope', { id: 'req-1', url: '/echo', headers: [entry('x', '${nope}')] })]);
    await expect(
      sendThroughEngine(sendDepsFor(model, { getSecret: secrets }), 's1', 'req-1', { draft: { kind: 'rest' } }),
    ).rejects.toMatchObject({ code: 'rest-unresolved-properties' });
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
