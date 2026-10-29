// @vitest-environment node
/**
 * A send under a protected environment (#345) asks first, at the one point every saved request's
 * send passes: declined, or with no one to ask, nothing reaches the wire; a caller that already
 * asked (a run, a batch) says so with `protectedConfirmed`. A host with no dialogs (the server) hands
 * the question to the tab with `needs-confirmation`, and the tab sends again `confirmed`.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi, createProject, createRestRequest } from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';
import { confirmProtectedSend, protectedEnvironmentOf, sendThroughEngine } from '../src/send/exchange.js';
import { channels } from '@wirebench/wire/ipc';
import { EngineService } from '../src/engine-service.js';
import { HandlerTable } from '../src/ipc/register.js';
import type { RequestChannelDeps } from '../src/ipc/request.js';
import { registerRestRequestChannels } from '../src/kinds/rest/ipc.js';
import { createNativeDialogs } from '../src/native-dialogs.js';
import { createFakePlatform, createHeadlessPlatform, fakeCaller } from './helpers/fake-platform.js';
import { sendDepsFor } from './helpers/send-deps.js';

let url = '';
let hits = 0;
const server = createServer((_req, res) => {
  hits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function model(guarded: boolean): Project {
  const environment: Environment = {
    id: 'prod',
    name: 'Prod',
    slug: 'prod',
    order: 0,
    endpoints: {},
    properties: {},
    disabledProperties: [],
    ...(guarded ? { protected: true } : {}),
  };
  const api = createApi('Pets', {
    id: 'api-1',
    baseUrl: url,
    requests: [createRestRequest('List', { id: 'rest-1', method: 'GET', url: '/pets' })],
  });
  return { ...createProject('Shop', { id: 'p1' }), containers: { rest: [api] }, environments: [environment] };
}

function depsOf(project: Project, confirmProtected?: (names: readonly string[]) => Promise<boolean>) {
  return sendDepsFor(project, {
    project: {
      runContextFor: () => ({ project, projectDir: '/tmp/none', globals: {}, environmentId: 'prod' }),
      restMeta: () => ({ requestName: 'List', apiName: 'Pets', folderPath: '' }),
    },
    ...(confirmProtected !== undefined ? { confirmProtected } : {}),
  });
}

const send = (deps: ReturnType<typeof depsOf>, sendId: string, extra: { protectedConfirmed?: boolean } = {}) =>
  sendThroughEngine(deps, sendId, 'rest-1', { draft: { kind: 'rest' }, ...extra });

describe('a send under a protected environment', () => {
  it('asks, and sends nothing when declined', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const before = hits;
    await expect(send(depsOf(model(true), confirm), 's1')).rejects.toMatchObject({
      code: 'send-declined',
      message: expect.stringContaining('Prod') as unknown,
    });
    expect(confirm).toHaveBeenCalledWith(['Prod']);
    expect(hits).toBe(before);
  });

  it('sends once confirmed', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const before = hits;
    await send(depsOf(model(true), confirm), 's2');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(hits).toBe(before + 1);
  });

  it('refuses when there is no one to ask', async () => {
    const before = hits;
    await expect(send(depsOf(model(true)), 's3')).rejects.toMatchObject({ code: 'send-declined' });
    expect(hits).toBe(before);
  });

  it('does not ask again for a send its caller already confirmed, nor for an unprotected environment', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const before = hits;
    await send(depsOf(model(true), confirm), 's4', { protectedConfirmed: true });
    await send(depsOf(model(false), confirm), 's5');
    expect(confirm).not.toHaveBeenCalled();
    expect(hits).toBe(before + 2);
  });
});

describe('a send under a protected environment on a host with no dialogs (the server)', () => {
  const headless = () => createNativeDialogs(createHeadlessPlatform()).confirmProtected;

  it('refuses with needs-confirmation naming the environment, rather than declining, and sends nothing', async () => {
    const before = hits;
    await expect(send(depsOf(model(true), headless()), 'h1')).rejects.toMatchObject({
      code: 'needs-confirmation',
      details: { environment: 'Prod', environments: ['Prod'] },
    });
    expect(hits).toBe(before);
  });

  it('sends once over request.sendRest when the tab says the person confirmed, and still refuses without it', async () => {
    const project = model(true);
    const deps = depsOf(project, headless()) as unknown as RequestChannelDeps;
    const table = new HandlerTable(deps.hostState.redactor);
    registerRestRequestChannels(table, new EngineService(), deps);
    const call = (request: unknown) => table.get(channels.request.sendRest.name)!(request, fakeCaller(1));
    const before = hits;
    await expect(call({ sendId: 'c1', requestId: 'rest-1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'needs-confirmation', details: { environment: 'Prod' } },
    });
    expect(hits).toBe(before);
    await expect(call({ sendId: 'c2', requestId: 'rest-1', confirmed: true })).resolves.toMatchObject({ ok: true });
    expect(hits).toBe(before + 1);
  });

  it('is a "no" for a run or a sequence, which ask through confirmProtectedSend and cannot ask the tab yet', async () => {
    await expect(confirmProtectedSend({ confirmProtected: headless() }, ['Prod'])).resolves.toBe(false);
  });

  it('leaves a desktop with dialogs asking natively, whatever it answers', async () => {
    const platform = createFakePlatform();
    // The fake dialogs answer Cancel: declined, as before.
    await expect(send(depsOf(model(true), createNativeDialogs(platform).confirmProtected), 'd1')).rejects.toMatchObject(
      { code: 'send-declined' },
    );
  });
});

describe('protectedEnvironmentOf', () => {
  it('names the protected environment a send runs under, inside a workspace too', () => {
    const project = model(false);
    expect(protectedEnvironmentOf({ project, environmentId: 'prod' })).toBeUndefined();
    expect(protectedEnvironmentOf({ project: model(true), environmentId: 'prod' })).toBe('Prod');
    expect(protectedEnvironmentOf({ project: model(true) })).toBeUndefined();
    const workspaceEnv = { ...project.environments[0]!, id: 'ws-prod', name: 'Production', protected: true };
    const workspace = { workspace: { environments: [workspaceEnv] } } as never;
    expect(protectedEnvironmentOf({ project, environmentId: 'ws-prod', workspace })).toBe('Production');
  });
});
