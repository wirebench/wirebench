// @vitest-environment node
/**
 * `sendToEnvironments` fans one saved request out to several environments: each child resolves
 * its endpoint (or base URL), properties and credentials under its own environment, settles on
 * its own, is recorded in History under its environment's name, and `request.cancel` with the
 * batch id aborts every child still running. The active environment is never touched. Every child
 * goes through the engine, against a real server.
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi, createInterface, createProject, createRequest, createRestRequest } from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';
import type { HistoryService } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { cancelEnvironmentBatch, sendToEnvironments } from '../src/main/multi-env-send.js';
import type { SendThroughEngineDeps } from '../src/main/send/exchange.js';
import { sendDepsFor } from './helpers/send-deps.js';

const ENVS = [
  { id: 'dev', name: 'Dev' },
  { id: 'test', name: 'Test' },
  { id: 'prod', name: 'Prod' },
];

/** What the server was sent, one request after another. */
const received: { url: string; authorization: string | undefined; body: string }[] = [];
/** The requests to `/hang`, which are never answered until the end. */
const hanging: ServerResponse[] = [];
let url = '';
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    received.push({
      url: req.url ?? '',
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (req.url?.startsWith('/hang') === true) {
      hanging.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': req.url?.startsWith('/soap') === true ? 'text/xml' : 'application/json' });
    res.end(
      req.url?.startsWith('/soap') === true
        ? '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ok/></s:Body></s:Envelope>'
        : '{}',
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  for (const res of hanging) res.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/**
 * One project with SOAP request `r1` and REST request `rest-1`, and the three environments: each
 * names its own SOAP endpoint and its own `stage` — except `unresolvedIn`, which has none.
 */
function model(opts: { unresolvedIn?: string; hang?: boolean } = {}): Project {
  const environments: Environment[] = ENVS.map((env, order) => ({
    ...env,
    slug: env.id,
    order,
    endpoints: { calc: `${url}/${opts.hang === true ? 'hang' : 'soap'}/${env.id}` },
    properties: env.id === opts.unresolvedIn ? {} : { stage: env.id },
    disabledProperties: [],
  }));
  const iface = createInterface('Calc', {
    id: 'iface-1',
    slug: 'calc',
    definitionUrl: 'http://127.0.0.1:1/x?wsdl',
    cacheDefinition: false,
    operations: [
      {
        name: 'Add',
        bindingName: '{urn:t}B',
        slug: 'add',
        order: 0,
        requests: [createRequest('Add', { id: 'r1', envelopeXml: '<saved/>', soapVersion: '1.1' })],
      },
    ],
  });
  const api = createApi('Pets', {
    id: 'api-1',
    baseUrl: url,
    // A credential's fields are never property-expanded: the environment shows in the URL.
    auth: { type: 'basic', username: 'user', passwordRef: 'ref' },
    requests: [createRestRequest('List pets', { id: 'rest-1', method: 'GET', url: '/pets/${#Env#stage}' })],
  });
  return { ...createProject('Shop', { id: 'p1' }), containers: { soap: [iface], rest: [api] }, environments };
}

function fakeProject(project: Project) {
  const active = { id: 'dev' };
  return {
    active,
    runContextFor: vi.fn((_requestId: string, envId?: string) => ({
      project,
      projectDir: '/tmp/none',
      globals: {},
      ...(envId !== undefined ? { environmentId: envId } : {}),
    })),
    requestMeta: () => ({ requestName: 'Add', interfaceName: 'Calc', operationName: 'Add' }),
    restMeta: () => ({ requestName: 'List pets', apiName: 'Pets', folderPath: '' }),
    projectId: () => 'p1',
    projectSnapshot: () => ({ environments: ENVS, activeEnvironmentId: active.id }),
    endpointFor: vi.fn((_requestId: string, envId?: string) =>
      ENVS.some((env) => env.id === envId) ? `http://${envId}.example/soap` : undefined,
    ),
  };
}

function fakeHistory() {
  return {
    recordSend: vi.fn(() => Promise.resolve(undefined)),
    recordRestSend: vi.fn(() => Promise.resolve(undefined)),
  };
}

/** The engine send over `project`, and the request channels' deps `sendToEnvironments` reads. */
function depsOf(
  project: ReturnType<typeof fakeProject> & Record<string, unknown>,
  history = fakeHistory(),
): { sendDeps: SendThroughEngineDeps; deps: RequestChannelDeps } {
  const surface = project as unknown as RequestChannelDeps['project'];
  const sendDeps = sendDepsFor(createProject('unused'), {
    project: surface,
    history: history as unknown as HistoryService,
    secretsFor: () => (ref) => Promise.resolve(ref === 'ref' ? 'pw' : undefined),
  });
  return { sendDeps, deps: { project: surface } };
}

const basic = (user: string): string => `Basic ${Buffer.from(`${user}:pw`).toString('base64')}`;

describe('sendToEnvironments', () => {
  it('sends a SOAP request once per environment with that environment’s endpoint and scopes', async () => {
    const project = fakeProject(model());
    const { sendDeps, deps } = depsOf(project);
    const before = received.length;
    const response = await sendToEnvironments(sendDeps, deps, {
      batchId: 'b1',
      requestId: 'r1',
      environmentIds: ['test', 'dev'],
      soap: { envelopeXml: '<Envelope>${#Env#stage}</Envelope>' },
    });

    expect(response.results.map((result) => [result.outcome, result.environmentId, result.environmentName])).toEqual([
      ['ok', 'test', 'Test'],
      ['ok', 'dev', 'Dev'],
    ]);
    const sent = response.results.map((result) => (result.outcome === 'ok' ? result.soap?.sendId : ''));
    expect(sent).toEqual(['b1:test', 'b1:dev']);
    // Each went to its environment's endpoint with its environment's `stage` in the editor's envelope.
    expect(
      received
        .slice(before)
        .map((request) => [request.url, request.body])
        .sort(),
    ).toEqual([
      ['/soap/dev', '<Envelope>dev</Envelope>'],
      ['/soap/test', '<Envelope>test</Envelope>'],
    ]);
    // The project, its TLS and everything else a send resolves follow the environment too.
    expect(project.runContextFor.mock.calls.map((call) => call[1])).toEqual(['test', 'dev']);
    expect(project.active.id).toBe('dev');
  });

  it('sends a REST request per environment, resolving its base URL and credentials there', async () => {
    const project = fakeProject(model());
    const { sendDeps, deps } = depsOf(project);
    const before = received.length;
    const response = await sendToEnvironments(sendDeps, deps, {
      batchId: 'b2',
      requestId: 'rest-1',
      environmentIds: ['dev', 'prod'],
      restDraft: {},
    });

    expect(response.results.every((result) => result.outcome === 'ok' && result.kind === 'rest')).toBe(true);
    const sent = received
      .slice(before)
      .map((request) => [request.url, request.authorization])
      .sort();
    expect(sent).toEqual([
      ['/pets/dev', basic('user')],
      ['/pets/prod', basic('user')],
    ]);
    expect(response.results.map((result) => (result.outcome === 'ok' ? result.rest?.sendId : ''))).toEqual([
      'b2:dev',
      'b2:prod',
    ]);
  });

  it('fails only the environment with unresolved properties', async () => {
    const { sendDeps, deps } = depsOf(fakeProject(model({ unresolvedIn: 'test' })));
    const response = await sendToEnvironments(sendDeps, deps, {
      batchId: 'b3',
      requestId: 'rest-1',
      environmentIds: ['dev', 'test', 'prod'],
    });

    expect(response.results.map((result) => result.outcome)).toEqual(['ok', 'error', 'ok']);
    expect(response.results[1]).toMatchObject({ code: 'rest-unresolved-properties', environmentName: 'Test' });
  });

  it('fails only an environment the project does not have', async () => {
    const { sendDeps, deps } = depsOf(fakeProject(model()));
    const response = await sendToEnvironments(sendDeps, deps, {
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
      ...fakeProject(model()),
      // Inside a workspace the router answers the workspace's environments; `dev` is one, `prod` is not.
      sendEnvironments: () => ({ environments: [{ id: 'dev', name: 'WS Dev' }], activeId: 'dev' }),
    };
    const { sendDeps, deps } = depsOf(project);
    const response = await sendToEnvironments(sendDeps, deps, {
      batchId: 'b5',
      requestId: 'r1',
      environmentIds: ['dev', 'prod'],
      soap: { envelopeXml: '<Envelope/>' },
    });

    expect(response.results[0]).toMatchObject({ outcome: 'ok', environmentName: 'WS Dev' });
    expect(response.results[1]).toMatchObject({ outcome: 'error', environmentId: 'prod', code: 'unknown-environment' });
  });

  it('cancels every child send of a batch', async () => {
    const { sendDeps, deps } = depsOf(fakeProject(model({ hang: true })));
    const cancel = vi.spyOn(sendDeps.registry, 'cancel');
    const before = hanging.length;
    const pending = sendToEnvironments(sendDeps, deps, {
      batchId: 'b5',
      requestId: 'r1',
      environmentIds: ['dev', 'test'],
      soap: { envelopeXml: '<Envelope/>' },
    });
    await vi.waitFor(() => expect(hanging.length - before).toBe(2));

    expect(cancelEnvironmentBatch(sendDeps.registry, 'b5')).toEqual({ cancelled: true });
    const response = await pending;
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(['b5:dev', 'b5:test']);
    expect(response.results.map((result) => result.outcome)).toEqual(['error', 'error']);
    // Once settled the batch is forgotten, and an ordinary send id is not a batch.
    expect(cancelEnvironmentBatch(sendDeps.registry, 'b5')).toBeUndefined();
  });

  it('records each child in History under its environment’s name', async () => {
    const history = fakeHistory();
    const soap = depsOf(fakeProject(model()), history);
    await sendToEnvironments(soap.sendDeps, soap.deps, {
      batchId: 'b6',
      requestId: 'r1',
      environmentIds: ['dev', 'test'],
      soap: { envelopeXml: '<Envelope/>' },
    });
    const rest = depsOf(fakeProject(model()), history);
    await sendToEnvironments(rest.sendDeps, rest.deps, {
      batchId: 'b7',
      requestId: 'rest-1',
      environmentIds: ['dev', 'prod'],
    });

    const soapNames = history.recordSend.mock.calls.map((call) => (call as unknown[])[1] as { requestName: string });
    const restNames = history.recordRestSend.mock.calls.map(
      (call) => (call as unknown[])[1] as { requestName: string },
    );
    expect(soapNames.map((entry) => entry.requestName).sort()).toEqual(['Add · Dev', 'Add · Test']);
    expect(restNames.map((entry) => entry.requestName).sort()).toEqual(['List pets · Dev', 'List pets · Prod']);
  });
});
