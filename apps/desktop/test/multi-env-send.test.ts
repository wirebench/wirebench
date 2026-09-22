// @vitest-environment node
/**
 * `sendToEnvironments` fans one saved request out to several environments: each child resolves
 * its endpoint (or base URL), properties and credentials under its own environment, settles on
 * its own, is recorded in History under its environment's name, and `request.cancel` with the
 * batch id aborts every child still running. The active environment is never touched.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PropertyScopes } from '@wirebench/engine';
import { WirebenchError } from '@wirebench/engine';
import type { EngineService } from '../src/main/engine-service.js';
import type { HistoryService } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { cancelEnvironmentBatch, sendToEnvironments } from '../src/main/multi-env-send.js';
import { restApiWire } from './helpers/wire-defaults.js';

const ENVS = [
  { id: 'dev', name: 'Dev' },
  { id: 'test', name: 'Test' },
  { id: 'prod', name: 'Prod' },
];

function scopes(envId: string | undefined): PropertyScopes {
  return { project: { env: envId ?? 'active' }, global: {}, system: {} };
}

function restResolution(envId: string | undefined, unresolved = false) {
  return {
    input: {
      baseUrl: `https://${envId ?? 'active'}.example`,
      request: {
        method: 'GET',
        url: '/pets',
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: 'none' },
      },
      settings: { timeoutMs: 1_000, followRedirects: true },
    },
    unresolved: unresolved ? [{ expr: '${missing}' }] : [],
    api: restApiWire(),
    request: { name: 'List pets' },
    baseUrlSource: 'environment',
    auth: { type: 'basic', username: `user-${envId ?? 'active'}`, passwordRef: 'ref' },
  };
}

function fakeProject(opts: { unresolvedIn?: string; kind?: 'soap' | 'rest' } = {}) {
  const active = { id: 'dev' };
  const project = {
    active,
    scopesFor: vi.fn((_requestId: string, envId?: string) => scopes(envId)),
    preflight: () => undefined as never,
    authFor: () => ({ type: 'basic', username: '${user}', password: '${password}' }),
    requestMeta: () => ({ requestName: 'Add', interfaceName: 'Calc', operationName: 'Add' }),
    restMeta: () => ({ requestName: 'List pets', apiName: 'Pets', folderPath: '' }),
    projectId: () => 'p1',
    projectSnapshot: () => ({ environments: ENVS, activeEnvironmentId: active.id }),
    requestSource: () => undefined as never,
    buildLiveSendInput: () => undefined,
    dumpFileFor: () => undefined,
    sendInputFor: vi.fn(
      (_requestId: string, overrides: { envelopeXml?: string; headers?: Record<string, string> }, envId?: string) =>
        ENVS.some((env) => env.id === envId)
          ? { endpoint: `http://${envId}.example/soap`, envelopeXml: overrides.envelopeXml ?? '' }
          : undefined,
    ),
    tlsFor: vi.fn(() => Promise.resolve(undefined)),
    restSend: vi.fn((_requestId: string, _draft: unknown, envId?: string) =>
      ENVS.some((env) => env.id === envId) ? restResolution(envId, envId === opts.unresolvedIn) : undefined,
    ),
  };
  return project;
}

function fakeService(opts: { hang?: boolean } = {}) {
  const controllers = new Map<string, AbortController>();
  const run = <T>(sendId: string, value: T): Promise<T> => {
    const controller = new AbortController();
    controllers.set(sendId, controller);
    return new Promise<T>((resolve, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new WirebenchError('cancelled', 'The send was cancelled')),
      );
      if (opts.hang !== true) {
        setTimeout(() => resolve(value), 1);
      }
    });
  };
  const service = {
    send: vi.fn<
      (
        request: { sendId: string; input: { endpoint: string } },
        options: { scopes?: PropertyScopes },
      ) => Promise<unknown>
    >((request) =>
      run(request.sendId, {
        sendId: request.sendId,
        durationMs: 3,
        http: { url: request.input.endpoint },
        problems: [],
      }),
    ),
    sendRestRequest: vi.fn<
      (request: { sendId: string; input: { baseUrl: string } }, options: unknown) => Promise<unknown>
    >((request) =>
      run(request.sendId, { sendId: request.sendId, url: request.input.baseUrl, status: 200, cookies: [] }),
    ),
    cancel: vi.fn((sendId: string) => {
      const controller = controllers.get(sendId);
      controller?.abort();
      return { cancelled: controller !== undefined };
    }),
    exchanges: { get: () => undefined },
  };
  return service;
}

function fakeHistory() {
  return {
    recordSend: vi.fn(() => Promise.resolve(undefined)),
    recordRestSend: vi.fn(() => Promise.resolve(undefined)),
  };
}

function depsOf(project: ReturnType<typeof fakeProject>, history = fakeHistory()): RequestChannelDeps {
  return {
    project: project as unknown as RequestChannelDeps['project'],
    history: history as unknown as HistoryService,
  };
}

describe('sendToEnvironments', () => {
  it('sends a SOAP request once per environment with that environment’s endpoint and scopes', async () => {
    const project = fakeProject();
    const service = fakeService();
    const response = await sendToEnvironments(service as unknown as EngineService, depsOf(project), {
      batchId: 'b1',
      requestId: 'r1',
      environmentIds: ['test', 'dev'],
      soap: { envelopeXml: '<Envelope/>' },
    });

    expect(response.results.map((result) => [result.outcome, result.environmentId, result.environmentName])).toEqual([
      ['ok', 'test', 'Test'],
      ['ok', 'dev', 'Dev'],
    ]);
    const sent = service.send.mock.calls.map(([request, options]) => [
      request.sendId,
      request.input.endpoint,
      options.scopes?.project['env'],
    ]);
    expect(sent).toEqual([
      ['b1:test', 'http://test.example/soap', 'test'],
      ['b1:dev', 'http://dev.example/soap', 'dev'],
    ]);
    // The per-endpoint TLS decision follows the environment too.
    expect(project.tlsFor.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['test', 'dev']);
    expect(project.active.id).toBe('dev');
  });

  it('sends a REST request per environment, resolving its base URL and credentials there', async () => {
    const project = fakeProject();
    const service = fakeService();
    const response = await sendToEnvironments(service as unknown as EngineService, depsOf(project), {
      batchId: 'b2',
      requestId: 'rest-1',
      environmentIds: ['dev', 'prod'],
      restDraft: {},
    });

    expect(response.results.every((result) => result.outcome === 'ok' && result.kind === 'rest')).toBe(true);
    const sent = service.sendRestRequest.mock.calls.map(([request, options]) => [
      request.sendId,
      request.input.baseUrl,
      (options as { auth: { username: string } }).auth.username,
    ]);
    expect(sent).toEqual([
      ['b2:dev', 'https://dev.example', 'user-dev'],
      ['b2:prod', 'https://prod.example', 'user-prod'],
    ]);
  });

  it('fails only the environment with unresolved properties', async () => {
    const project = fakeProject({ unresolvedIn: 'test' });
    const response = await sendToEnvironments(fakeService() as unknown as EngineService, depsOf(project), {
      batchId: 'b3',
      requestId: 'rest-1',
      environmentIds: ['dev', 'test', 'prod'],
    });

    expect(response.results.map((result) => result.outcome)).toEqual(['ok', 'error', 'ok']);
    expect(response.results[1]).toMatchObject({ code: 'rest-unresolved-properties', environmentName: 'Test' });
  });

  it('fails only an environment the project does not have', async () => {
    const response = await sendToEnvironments(fakeService() as unknown as EngineService, depsOf(fakeProject()), {
      batchId: 'b4',
      requestId: 'r1',
      environmentIds: ['dev', 'gone'],
      soap: { envelopeXml: '<Envelope/>' },
    });

    expect(response.results[0]?.outcome).toBe('ok');
    expect(response.results[1]).toMatchObject({
      outcome: 'error',
      environmentId: 'gone',
      code: 'unknown-environment',
    });
  });

  it('names and validates against the environments that apply (a workspace’s), not the project’s', async () => {
    const project = {
      ...fakeProject(),
      // Inside a workspace the router answers the workspace's environments; `dev` is one, `prod` is not.
      sendEnvironments: () => ({ environments: [{ id: 'dev', name: 'WS Dev' }], activeId: 'dev' }),
    };
    const response = await sendToEnvironments(fakeService() as unknown as EngineService, depsOf(project), {
      batchId: 'b5',
      requestId: 'r1',
      environmentIds: ['dev', 'prod'],
      soap: { envelopeXml: '<Envelope/>' },
    });

    expect(response.results[0]).toMatchObject({ outcome: 'ok', environmentName: 'WS Dev' });
    expect(response.results[1]).toMatchObject({ outcome: 'error', environmentId: 'prod', code: 'unknown-environment' });
  });

  it('cancels every child send of a batch', async () => {
    const service = fakeService({ hang: true });
    const pending = sendToEnvironments(service as unknown as EngineService, depsOf(fakeProject()), {
      batchId: 'b5',
      requestId: 'r1',
      environmentIds: ['dev', 'test'],
      soap: { envelopeXml: '<Envelope/>' },
    });
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledTimes(2));

    expect(cancelEnvironmentBatch(service as unknown as EngineService, 'b5')).toEqual({ cancelled: true });
    const response = await pending;
    expect(service.cancel.mock.calls.map(([id]) => id)).toEqual(['b5:dev', 'b5:test']);
    expect(response.results.map((result) => result.outcome)).toEqual(['error', 'error']);
    // Once settled the batch is forgotten, and an ordinary send id is not a batch.
    expect(cancelEnvironmentBatch(service as unknown as EngineService, 'b5')).toBeUndefined();
  });

  it('records each child in History under its environment’s name', async () => {
    const history = fakeHistory();
    await sendToEnvironments(fakeService() as unknown as EngineService, depsOf(fakeProject(), history), {
      batchId: 'b6',
      requestId: 'r1',
      environmentIds: ['dev', 'test'],
      soap: { envelopeXml: '<Envelope/>' },
    });
    await sendToEnvironments(fakeService() as unknown as EngineService, depsOf(fakeProject(), history), {
      batchId: 'b7',
      requestId: 'rest-1',
      environmentIds: ['dev', 'prod'],
    });

    const soapNames = history.recordSend.mock.calls.map((call) => (call as unknown[])[1] as { requestName: string });
    const restNames = history.recordRestSend.mock.calls.map(
      (call) => (call as unknown[])[1] as { requestName: string },
    );
    expect(soapNames.map((entry) => entry.requestName)).toEqual(['Add · Dev', 'Add · Test']);
    expect(restNames.map((entry) => entry.requestName)).toEqual(['List pets · Dev', 'List pets · Prod']);
  });
});
