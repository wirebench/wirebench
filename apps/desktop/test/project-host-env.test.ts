// @vitest-environment node
/**
 * `ProjectHost` resolving a request under a *named* environment rather than the active one:
 * the REST base URL and property values, the SOAP endpoint, and the SOAP send input (resolved
 * through the engine, as a send resolves them) all follow
 * the `envId` asked for, and the active environment is never touched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RestApi, Workspace, WorkspaceEnvironment } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import {
  ExchangeRegistry,
  previewRest,
  previewSoap,
  type RestPreview,
  type SendThroughEngineDeps,
} from '../src/main/send/exchange.js';

let dir: string;
let host: ProjectHost;
let server: TestSoapServer;

/** Where a resolved REST send goes: its expanded base URL joined to its expanded path. */
function target(resolution: RestPreview | undefined): string | undefined {
  return resolution === undefined ? undefined : `${resolution.input.baseUrl}${resolution.input.request.url}`;
}

/** The host as a send's dependencies see it. */
const deps = (): SendThroughEngineDeps => ({
  service: new EngineService(),
  registry: new ExchangeRegistry(),
  project: host as unknown as SendThroughEngineDeps['project'],
});

/** `requestId` resolved as its send would resolve it, under `envId` or the active environment. */
const restSend = (requestId: string, envId?: string) => previewRest(deps(), requestId, undefined, envId);

/** The SOAP input a send of `requestId` would resolve, under `envId` or the active environment. */
const soapInput = async (requestId: string, envId?: string) =>
  (await previewSoap(deps(), requestId, undefined, envId))?.input;

async function addEnvironment(
  name: string,
  patch: { endpoints?: Record<string, string>; properties?: Record<string, string> },
): Promise<string> {
  const added = await host.mutate({ kind: 'add-environment', name });
  const id = added.project.environments.find((environment) => environment.name === name)?.id as string;
  await host.mutate({ kind: 'update-environment', environmentId: id, patch });
  return id;
}

/** A REST API with one request whose path expands `${#Env#tenant}`, and two environments. */
async function restProject(): Promise<{ requestId: string; dev: string; test: string }> {
  await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: 'https://api.default' });
  const api = host.model()?.apis[0] as RestApi;
  await host.mutate({ kind: 'add-rest-request', apiId: api.id });
  const request = (host.model()?.apis[0] as RestApi).requests[0];
  const requestId = request?.id as string;
  await host.mutate({ kind: 'update-rest-request', requestId, patch: { url: '/pets/${tenant}' } });
  const dev = await addEnvironment('dev', {
    endpoints: { [api.slug]: 'https://dev.example' },
    properties: { tenant: 'alpha' },
  });
  const test = await addEnvironment('test', {
    endpoints: { [api.slug]: 'https://test.example' },
    properties: { tenant: 'beta' },
  });
  await host.mutate({ kind: 'set-active-environment', environmentId: dev });
  return { requestId, dev, test };
}

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  dir = mkdtempSync(join(tmpdir(), 'wirebench-host-env-'));
  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(dir, 'project'), name: 'Envs' });
});

afterEach(async () => {
  await host.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ProjectHost under a named environment', () => {
  it('resolves a REST send against the named environment, leaving the active one alone', async () => {
    const { requestId, dev, test } = await restProject();
    const active = await restSend(requestId);
    expect(target(active)).toBe('https://dev.example/pets/alpha');
    expect(target(await restSend(requestId, dev))).toBe(target(active));

    const other = await restSend(requestId, test);
    expect(target(other)).toBe('https://test.example/pets/beta');
    expect(other?.baseUrlSource).toBe('environment');
    expect(host.model()?.activeEnvironmentId).toBe(dev);
    expect(target(await restSend(requestId))).toBe('https://dev.example/pets/alpha');
  });

  it('refuses an environment the project does not have', async () => {
    const { requestId } = await restProject();
    expect(await restSend(requestId, 'no-such-env')).toBeUndefined();
  });

  it('resolves a SOAP endpoint and send input under the named environment', async () => {
    await host.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
    await host.whenHydrated();
    const requestId = host.snapshot()?.requests[0]?.id as string;
    const slug = host.snapshot()?.interfaces[0]?.slug as string;
    const dev = await addEnvironment('dev', { endpoints: { [slug]: 'http://dev.example/soap' } });
    const test = await addEnvironment('test', { endpoints: { [slug]: 'http://test.example/soap' } });
    await host.mutate({ kind: 'set-active-environment', environmentId: dev });

    expect(host.endpointFor(requestId)).toBe('http://dev.example/soap');
    expect(host.endpointFor(requestId, test)).toBe('http://test.example/soap');
    expect((await soapInput(requestId))?.endpoint).toBe('http://dev.example/soap');
    expect((await soapInput(requestId, test))?.endpoint).toBe('http://test.example/soap');
    expect(host.endpointFor(requestId, 'no-such-env')).toBeUndefined();
    expect(await soapInput(requestId, 'no-such-env')).toBeUndefined();
    expect(host.model()?.activeEnvironmentId).toBe(dev);
  });
});

/** A workspace environment overriding the `proj/<slug>` endpoint and one property. */
function workspaceEnv(id: string, order: number, slug: string, url: string, tenant: string): WorkspaceEnvironment {
  return {
    id,
    name: id.toUpperCase(),
    slug: `ws-${id}`,
    order,
    properties: { tenant },
    endpoints: { [`proj/${slug}`]: url },
    disabledProperties: [],
  };
}

/** Opens the host inside a workspace with two environments, `wdev` active. */
function insideWorkspace(slug: string): { workspace: () => Workspace } {
  const workspace: Workspace = {
    formatVersion: 3,
    id: 'ws',
    name: 'WS',
    createdAt: '2026-09-22T00:00:00.000Z',
    properties: {},
    disabledProperties: [],
    projects: [],
    activeEnvironmentId: 'wdev',
    environments: [
      workspaceEnv('wtest', 1, slug, 'https://wtest.example', 'beta'),
      workspaceEnv('wdev', 0, slug, 'https://wdev.example', 'alpha'),
    ],
  };
  host.setWorkspaceContext(() => ({ workspace, projectSlug: 'proj' }));
  return { workspace: () => workspace };
}

describe('ProjectHost under a named workspace environment', () => {
  it('resolves a REST send against the named workspace environment, leaving the active one alone', async () => {
    await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: 'https://api.default' });
    const api = host.model()?.apis[0] as RestApi;
    await host.mutate({ kind: 'add-rest-request', apiId: api.id });
    const requestId = (host.model()?.apis[0] as RestApi).requests[0]?.id as string;
    await host.mutate({ kind: 'update-rest-request', requestId, patch: { url: '/pets/${tenant}' } });
    const ws = insideWorkspace(api.slug);

    const before = target(await restSend(requestId));
    expect(before).toBe('https://wdev.example/pets/alpha');
    const other = await restSend(requestId, 'wtest');
    expect(target(other)).toBe('https://wtest.example/pets/beta');
    expect(other?.baseUrlSource).toBe('workspace-environment');
    expect(host.scopesFor('wtest').env).toEqual({ tenant: 'beta' });
    expect(host.scopesFor().env).toEqual({ tenant: 'alpha' });

    expect(ws.workspace().activeEnvironmentId).toBe('wdev');
    expect(target(await restSend(requestId))).toBe(before);
    expect(host.sendEnvironments()).toEqual({
      environments: [
        { id: 'wdev', name: 'WDEV' },
        { id: 'wtest', name: 'WTEST' },
      ],
      activeId: 'wdev',
    });
  });

  it('refuses an id that is not a workspace environment, a project one included', async () => {
    await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: 'https://api.default' });
    const api = host.model()?.apis[0] as RestApi;
    await host.mutate({ kind: 'add-rest-request', apiId: api.id });
    const requestId = (host.model()?.apis[0] as RestApi).requests[0]?.id as string;
    const projectEnv = await addEnvironment('dev', { endpoints: { [api.slug]: 'https://dev.example' } });
    insideWorkspace(api.slug);
    expect(await restSend(requestId, 'no-such-env')).toBeUndefined();
    expect(await restSend(requestId, projectEnv)).toBeUndefined();
  });

  it('resolves a SOAP endpoint under the named workspace environment', async () => {
    await host.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
    await host.whenHydrated();
    const requestId = host.snapshot()?.requests[0]?.id as string;
    const slug = host.snapshot()?.interfaces[0]?.slug as string;
    const ws = insideWorkspace(slug);

    expect(host.endpointFor(requestId)).toBe('https://wdev.example');
    expect(host.endpointFor(requestId, 'wtest')).toBe('https://wtest.example');
    expect((await soapInput(requestId, 'wtest'))?.endpoint).toBe('https://wtest.example');
    expect((await soapInput(requestId))?.endpoint).toBe('https://wdev.example');
    expect(host.endpointFor(requestId, 'no-such-env')).toBeUndefined();
    expect(ws.workspace().activeEnvironmentId).toBe('wdev');
  });
});

describe('ProjectHost for the send host', () => {
  it("answers a request's run context under its project's environment", async () => {
    const { requestId, dev, test } = await restProject();
    const context = host.runContextFor(requestId);
    expect(context?.project).toBe(host.model());
    expect(context?.projectDir).toBe(join(dir, 'project'));
    expect(context?.environmentId).toBe(dev);
    expect(context?.workspace).toBeUndefined();
    expect(host.runContextFor(requestId, test)?.environmentId).toBe(test);
    expect(host.runContextFor(requestId, 'no-such-env')).toBeUndefined();
    expect(context?.globals).toEqual({});
  });

  it('answers the workspace and its environment inside a workspace, leaving the active one alone', async () => {
    await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: 'https://api.default' });
    const api = host.model()?.apis[0] as RestApi;
    await host.mutate({ kind: 'add-rest-request', apiId: api.id });
    const requestId = (host.model()?.apis[0] as RestApi).requests[0]?.id as string;
    const ws = insideWorkspace(api.slug);

    const active = host.runContextFor(requestId);
    expect(active?.environmentId).toBe('wdev');
    expect(active?.workspace).toEqual({ workspace: ws.workspace(), projectSlug: 'proj' });
    const named = host.runContextFor(requestId, 'wtest');
    expect(named?.environmentId).toBe('wtest');
    expect(named?.workspace?.workspace.activeEnvironmentId).toBe('wtest');
    expect(ws.workspace().activeEnvironmentId).toBe('wdev');
  });

  it("hands back a request's stored cookies whatever its send-cookies setting", async () => {
    const { requestId } = await restProject();
    const cookie = { name: 'sid', value: 'abc' } as never;
    expect(host.restCookiesFor(requestId)).toBeUndefined();
    host.rememberRestCookies(requestId, [cookie]);
    expect(host.restCookiesFor(requestId)).toEqual([cookie]);
    // The request's own resolution still sends none: its setting is off.
    expect((await restSend(requestId))?.input.cookies).toBeUndefined();
    host.rememberRestCookies(requestId, []);
    expect(host.restCookiesFor(requestId)).toBeUndefined();
  });

  it('lends no trust anchors and no identity when nothing is configured', async () => {
    expect(await host.trustAnchors()).toBeUndefined();
    expect(await host.clientIdentityFor(undefined)).toBeUndefined();
  });
});

describe('ProjectHost.runContextFor with global properties', () => {
  it('carries the enabled globals, as scopesFor reads them', async () => {
    const globals = { get: () => ({ properties: { x: 'g', off: 'o' }, disabled: ['off'] }) };
    const withGlobals = new ProjectHost(
      new EngineService(),
      {},
      undefined,
      globals,
      undefined,
      undefined,
      new DialogPicks(),
    );
    try {
      await withGlobals.create({ dir: join(dir, 'globals'), name: 'Globals' });
      expect(withGlobals.runContextFor('any')?.globals).toEqual({ x: 'g' });
      expect(withGlobals.scopesFor().global).toEqual({ x: 'g' });
    } finally {
      await withGlobals.close();
    }
  });
});
