// @vitest-environment node
/**
 * The WebSocket send path in main: the target, chain, expansion and settings an open resolves
 * (`previewWs`, which the editor's badge and the command export read).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import { createProject, createWsApi, createWsFolder, createWsRequest, entry } from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';
import { previewWs } from '../src/main/send/exchange.js';
import type { WsRequestPatchWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

let server: TestWsServer;

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

function project(): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { who: 'Ada', tenant: 'acme', host: server.url },
    wsApis: [
      createWsApi('Chat', {
        id: 'w-1',
        url: '${host}',
        headers: [entry('x-api', 'ws')],
        auth: { type: 'bearer', tokenRef: 'sec_tok' },
        folders: [
          createWsFolder('Rooms', {
            id: 'f-1',
            requests: [
              createWsRequest('Echo', {
                id: 'q-1',
                url: '/echo',
                query: [entry('who', '${who}')],
                headers: [entry('x-trace', 'abc')],
                subprotocols: ['chat.${tenant}'],
              }),
            ],
          }),
        ],
      }),
    ],
  };
}

/** `requestId` of `model` resolved as its open would resolve it, under the model's active environment. */
function resolve(
  model: Project = project(),
  options: { readonly draft?: WsRequestPatchWire; readonly requestId?: string } = {},
) {
  const deps = sendDepsFor(model, {
    project: {
      runContextFor: () => ({
        project: model,
        projectDir: '/tmp/none',
        globals: {},
        ...(model.activeEnvironmentId !== undefined ? { environmentId: model.activeEnvironmentId } : {}),
      }),
    },
  });
  return previewWs(deps, options.requestId ?? 'q-1', options.draft);
}

describe('resolving a WebSocket open (previewWs)', () => {
  it('applies the draft, expands the target under the environment, headers, query and subprotocols', async () => {
    const resolved = (await resolve())!;
    expect(resolved.input.serverUrl).toBe(server.url);
    expect(resolved.input.request.url).toBe('/echo');
    expect(resolved.input.request.query).toEqual([entry('who', 'Ada')]);
    expect(resolved.input.request.headers).toEqual([entry('x-trace', 'abc')]);
    expect(resolved.input.request.subprotocols).toEqual(['chat.acme']);
    expect(resolved.input.apiHeaders).toEqual([entry('x-api', 'ws')]);
    expect(resolved.auth).toEqual({ type: 'bearer', tokenRef: 'sec_tok' });
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.urlSource).toBe('api');
  });

  it('applies the environment override, which beats the API own target', async () => {
    const dev: Environment = {
      id: 'env-dev',
      name: 'dev',
      slug: 'dev',
      order: 0,
      endpoints: { [project().wsApis[0]!.slug]: server.url },
      properties: {},
      disabledProperties: [],
    };
    const model: Project = {
      ...project(),
      properties: { who: 'Ada', tenant: 'acme' },
      environments: [dev],
      activeEnvironmentId: dev.id,
    };
    const resolved = (await resolve(model))!;
    expect(resolved.input.serverUrl).toBe(server.url);
    expect(resolved.urlSource).toBe('environment');
  });

  it('resolves the auth chain: request inherits, so the folder above it wins over the API', async () => {
    const base = project();
    const p: Project = {
      ...base,
      wsApis: [
        {
          ...base.wsApis[0]!,
          auth: { type: 'bearer', tokenRef: 'api-tok' },
          folders: [
            {
              ...base.wsApis[0]!.folders[0]!,
              auth: { type: 'basic', username: 'u', passwordRef: 'folder-pass' },
              requests: [{ ...base.wsApis[0]!.folders[0]!.requests[0]!, auth: { type: 'inherit' } }],
            },
          ],
        },
      ],
    };
    const resolved = (await resolve(p))!;
    expect(resolved.auth).toEqual({ type: 'basic', username: 'u', passwordRef: 'folder-pass' });
  });

  it('reports an unresolved property in a draft, and returns undefined for an unknown request', async () => {
    const drafted = (await resolve(project(), { draft: { url: '/echo/${nope}' } }))!;
    expect(drafted.unresolved.map((ref) => ref.name)).toEqual(['nope']);
    expect(await resolve(project(), { requestId: 'zz' })).toBeUndefined();
  });

  it('lets the request settings fall back through the project default and then preferences', async () => {
    const withProjectDefault: Project = { ...project(), settings: { ...project().settings, defaultTimeoutMs: 5_000 } };
    const resolved = (await resolve(withProjectDefault))!;
    expect(resolved.input.request.settings.handshakeTimeoutMs).toBe(5_000);
  });
});
