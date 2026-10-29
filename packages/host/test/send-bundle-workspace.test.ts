// @vitest-environment node
/**
 * The send bundle of a project inside a server workspace (hosted edition spec §18.4), the branch every real
 * browser send takes, round-tripped: built on a host over a real `WorkspaceService`, written out and sent by
 * another host's `sendFromDirectory`, as the agent does, to a local echo server. The agent must send what the
 * server's own preview resolves; a protected environment needs the tab's `confirmed`; and an environment that
 * does not override the container leaves its address ladder (a SOAP endpoint's `trustInvalid`) in charge.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateServerCert, generateTestCa } from '@wirebench/engine/test-helpers';
import {
  CookieJar,
  createApi,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  createWorkspace,
  entry,
  saveProject,
  saveWorkspace,
  workspaceDir,
  workspaceProjectDir,
  type Environment,
  type Project,
  type WorkspaceEnvironment,
} from '@wirebench/engine';
import type { SendBundle } from '@wirebench/wire/agent';
import type { RestExchangeSummary } from '@wirebench/wire/kinds/rest/wire';
import type { ExchangeSummary } from '@wirebench/wire/kinds/soap/wire';
import { EngineService } from '../src/engine-service.js';
import { HistoryService } from '../src/history-service.js';
import { createHost, type Host } from '../src/host/create-host.js';
import { createHostState } from '../src/host/host-state.js';
import { serveCall } from '../src/host/serve-call.js';
import { buildSendBundle } from '../src/send-bundle.js';
import { agentSecretLabel, createSendSession } from '../src/send/detached.js';
import { ExchangeRegistry, previewRest, type SendThroughEngineDeps } from '../src/send/exchange.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { createFakePlatform, fakeCaller } from './helpers/fake-platform.js';

const PAIRING = 'pairing-1';
const SERVER_WORKSPACE = 'ws_server_1';
const WS_SECRET = 'ws-secret-value-0123456789';
const GLOBAL_SECRET = 'global-secret-value-0123456789';

interface Received {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

const closers: (() => Promise<void> | void)[] = [];
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wirebench-bundle-ws-')));
  closers.push(() => rmSync(root, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** Answers every request 200 with an XML body, recording what it received; over TLS with `tls`. */
async function echo(tls?: { cert: string; key: string }): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    request.resume();
    request.on('end', () => {
      received.push({ url: request.url ?? '', headers: request.headers });
      response.writeHead(200, { 'content-type': 'text/xml' });
      response.end('<ok/>');
    });
  };
  const server: Server = tls === undefined ? createHttpServer(handler) : createHttpsServer(tls, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, received };
}

const DEV_WS: WorkspaceEnvironment = {
  id: 'env-dev',
  name: 'Dev',
  slug: 'dev',
  order: 0,
  properties: { envOnly: 'from-ws-env', shared: 'from-ws-env', flip: 'from-ws-env' },
  endpoints: {},
  disabledProperties: [],
};

/** The project environment linked to `Dev` (same slug): it wins on a shared name, and switches `flip` off. */
const DEV_LINKED: Environment = {
  id: 'penv-dev',
  name: 'Dev',
  slug: 'dev',
  order: 0,
  properties: { shared: 'from-linked', flip: 'from-linked' },
  endpoints: {},
  disabledProperties: ['flip'],
};

/** A workspace holding `project` as `Billing`, with `environment`, open in a service whose system scope is `system`. */
async function openWorkspace(
  project: Project,
  environment: WorkspaceEnvironment,
  system: Record<string, string>,
): Promise<{ service: WorkspaceService; deps: SendThroughEngineDeps }> {
  const workspace = {
    ...createWorkspace('Team'),
    projects: [{ id: project.id, slug: 'Billing', source: 'internal' as const }],
    properties: { wsToken: '${secret:ws_token}', wsOnly: 'from-workspace' },
    environments: [environment],
  };
  const dir = workspaceDir(root, workspace.id);
  await saveWorkspace(workspace, dir);
  await saveProject(project, workspaceProjectDir(dir, 'Billing'));
  const hostState = { ...createHostState(), systemValues: system };
  const service = new WorkspaceService({
    hostState,
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root, hostState.redactor),
    globals: { get: () => ({ properties: { gToken: '${secret:g_token}' }, disabled: [] }) },
    trash: () => Promise.resolve(),
  });
  closers.push(async () => {
    await service.close();
  });
  await service.open(workspace.id);
  await service.setActiveEnvironment({ projectId: project.id, environmentId: environment.id });
  return {
    service,
    deps: { hostState, service: new EngineService(), registry: new ExchangeRegistry(), project: service },
  };
}

/** The agent's side: a host of its own, its agent namespace holding the two secrets. */
async function agentHost(): Promise<Host> {
  const host = await createHost(createFakePlatform());
  closers.push(() => host.shutdown());
  const caller = fakeCaller(9);
  host.attach(caller);
  for (const [name, value] of [
    ['ws_token', WS_SECRET],
    ['g_token', GLOBAL_SECRET],
  ] as const) {
    const label = agentSecretLabel(PAIRING, SERVER_WORKSPACE, name);
    expect(await serveCall(host, caller, { id: 1, channel: 'secrets.set', request: { value, label } })).toMatchObject({
      ok: true,
    });
  }
  await host.detach(caller.id);
  return host;
}

/** `bundle` written to a folder of its own and sent from there, as the agent sends it. */
async function sendBundle(
  host: Host,
  bundle: SendBundle,
  systemValues: Record<string, string>,
): Promise<RestExchangeSummary | ExchangeSummary> {
  const dir = mkdtempSync(join(root, 'bundle-'));
  for (const file of bundle.files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  const jar = new CookieJar();
  return await host.sendFromDirectory({
    sendId: 'agent-send',
    projectDir: dir,
    itemId: bundle.itemId,
    ...(bundle.environment !== undefined ? { environment: bundle.environment } : {}),
    kind: bundle.kind,
    pairingId: PAIRING,
    origin: 'https://team.example.test',
    workspaceId: bundle.workspaceId,
    secretNames: bundle.secretNames,
    systemValues,
    scopes: { workspace: bundle.scopes?.workspace ?? {}, global: bundle.scopes?.global ?? {} },
    cookies: {
      cookiesFor: (url) => jar.cookiesFor(url, Date.now()),
      remember: (url, cookies) => jar.store(url, cookies, Date.now()),
    },
    session: createSendSession(host, { egress: undefined }),
  });
}

function bundleDeps(deps: SendThroughEngineDeps) {
  return { send: deps, serverWorkspaceId: () => SERVER_WORKSPACE };
}

/** One REST request under an API the workspace environment overrides, beside one it does not. */
function restProject(): Project {
  const request = createRestRequest('Echo', {
    id: 'req-1',
    url: '/echo',
    headers: [
      entry('X-Env', '${envOnly}'),
      entry('X-Shared', '${shared}'),
      entry('X-Flip', '${flip}'),
      entry('X-Ws-Only', '${#Workspace#wsOnly}'),
      entry('X-Ws-Token', '${#Workspace#wsToken}'),
      entry('X-Global-Token', '${#Global#gToken}'),
    ],
  });
  const pets = createApi('Pets', {
    id: 'api-1',
    slug: 'pets',
    baseUrl: 'http://127.0.0.1:1/never',
    requests: [request],
  });
  const plain = createApi('Plain', {
    id: 'api-2',
    slug: 'plain',
    baseUrl: 'http://127.0.0.1:${#System#ECHO_PORT}/plain',
    requests: [createRestRequest('Plain', { id: 'req-2', url: '/x' })],
  });
  return {
    ...createProject('Billing', { id: 'project-billing' }),
    environments: [DEV_LINKED],
    containers: { rest: [pets, plain] },
  };
}

describe('a server-workspace bundle, round-tripped through the agent', () => {
  it('sends the URL and headers the server previews, its secrets resolved on the agent and refs in the bundle', async () => {
    const server = await echo();
    const system = { ECHO_PORT: String(server.port) };
    const environment = {
      ...DEV_WS,
      endpoints: { 'Billing/pets': 'http://127.0.0.1:${#System#ECHO_PORT}/ws' },
    };
    const { deps } = await openWorkspace(restProject(), environment, system);

    const preview = await previewRest(deps, 'req-1', undefined);
    expect(preview).toBeDefined();
    const previewUrl = `${preview!.input.baseUrl}${preview!.input.request.url}`;
    expect(previewUrl).toBe(`http://127.0.0.1:${String(server.port)}/ws/echo`);
    const previewHeaders = Object.fromEntries(
      preview!.input.request.headers.map((header) => [header.name.toLowerCase(), header.value]),
    );
    expect(previewHeaders).toMatchObject({
      'x-env': 'from-ws-env',
      'x-shared': 'from-linked',
      // Switched off in the linked environment, so the workspace environment's value applies.
      'x-flip': 'from-ws-env',
      'x-ws-only': 'from-workspace',
      'x-ws-token': '${secret:ws_token}',
      'x-global-token': '${secret:g_token}',
    });

    const bundle = await buildSendBundle(bundleDeps(deps), { projectId: 'project-billing', itemId: 'req-1' });
    // The secrets stay refs in the scopes; the agent reads their values from its own namespace.
    expect(bundle.scopes).toEqual({
      workspace: { wsToken: '${secret:ws_token}', wsOnly: 'from-workspace' },
      global: { gToken: '${secret:g_token}' },
    });
    expect(JSON.stringify(bundle)).not.toContain(WS_SECRET);
    expect(bundle.secretNames).toEqual(expect.arrayContaining(['ws_token', 'g_token']));
    expect(bundle.systemNames).toEqual(['ECHO_PORT']);

    const result = (await sendBundle(await agentHost(), bundle, system)) as RestExchangeSummary;
    expect(result.http.status).toBe(200);
    const sent = server.received[0]!;
    expect(`http://127.0.0.1:${String(server.port)}${sent.url}`).toBe(previewUrl);
    for (const [name, value] of Object.entries(previewHeaders)) {
      if (name === 'x-ws-token') expect(sent.headers[name]).toBe(WS_SECRET);
      else if (name === 'x-global-token') expect(sent.headers[name]).toBe(GLOBAL_SECRET);
      else expect(sent.headers[name]).toBe(value);
    }
  });

  it("leaves a container the environment does not override at its own address, not the server's resolved one", async () => {
    const server = await echo();
    const system = { ECHO_PORT: String(server.port) };
    const { deps } = await openWorkspace(restProject(), DEV_WS, system);
    const bundle = await buildSendBundle(bundleDeps(deps), { projectId: 'project-billing', itemId: 'req-2' });
    const environmentFile = bundle.files.find((file) => file.path.startsWith('environments/'));
    expect(environmentFile?.content).not.toContain('127.0.0.1');
    await sendBundle(await agentHost(), bundle, system);
    expect(server.received.map((received) => received.url)).toEqual(['/plain/x']);
  });
});

describe('a protected environment', () => {
  it('needs the tab to confirm before the bundle is built, and the bundle it then builds is not protected', async () => {
    const server = await echo();
    const system = { ECHO_PORT: String(server.port) };
    const environment = {
      ...DEV_WS,
      protected: true,
      endpoints: { 'Billing/pets': 'http://127.0.0.1:${#System#ECHO_PORT}/ws' },
    };
    const { deps } = await openWorkspace(restProject(), environment, system);
    const item = { projectId: 'project-billing', itemId: 'req-1' };

    await expect(buildSendBundle(bundleDeps(deps), item)).rejects.toMatchObject({
      code: 'needs-confirmation',
      details: { environment: 'Dev' },
    });
    await expect(buildSendBundle(bundleDeps(deps), { ...item, confirmed: false })).rejects.toMatchObject({
      code: 'needs-confirmation',
    });
    expect(server.received).toEqual([]);

    const bundle = await buildSendBundle(bundleDeps(deps), { ...item, confirmed: true });
    expect(bundle.files.some((file) => file.content.includes('protected'))).toBe(false);
    // The agent's host would refuse a protected environment (no one to ask): it sends.
    const result = (await sendBundle(await agentHost(), bundle, system)) as RestExchangeSummary;
    expect(result.http.status).toBe(200);
    expect(server.received).toHaveLength(1);
  });

  it('counts the linked project environment being protected', async () => {
    const project = restProject();
    const linked = { ...project, environments: [{ ...DEV_LINKED, protected: true }] };
    const { deps } = await openWorkspace(linked, DEV_WS, {});
    await expect(
      buildSendBundle(bundleDeps(deps), { projectId: 'project-billing', itemId: 'req-1' }),
    ).rejects.toMatchObject({ code: 'needs-confirmation', details: { environment: 'Dev' } });
  });
});

describe('a SOAP endpoint the environment does not override', () => {
  it('keeps its trustInvalid through the agent, to a self-signed server', async () => {
    const cert = generateServerCert(generateTestCa());
    const server = await echo({ cert: cert.certPem, key: cert.keyPem });
    const request = createRequest('Add', {
      id: 'soap-1',
      envelopeXml:
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>',
      soapVersion: '1.1',
      endpointId: 'ep-1',
    });
    const iface = createInterface('Calc', {
      id: 'iface-1',
      slug: 'calc',
      definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
      cacheDefinition: false,
      endpoints: [
        {
          id: 'ep-1',
          name: 'Self-signed',
          url: `https://127.0.0.1:${String(server.port)}/soap`,
          authMode: 'complement',
          trustInvalid: true,
        },
      ],
      operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
    });
    const project: Project = {
      ...createProject('Billing', { id: 'project-billing' }),
      containers: { soap: [iface] },
    };
    const { deps } = await openWorkspace(project, DEV_WS, {});
    const bundle = await buildSendBundle(bundleDeps(deps), { projectId: 'project-billing', itemId: 'soap-1' });
    const result = (await sendBundle(await agentHost(), bundle, {})) as ExchangeSummary;
    expect(result.http.status).toBe(200);
    expect(server.received.map((received) => received.url)).toEqual(['/soap']);
  });
});
