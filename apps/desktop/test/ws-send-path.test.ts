// @vitest-environment node
/**
 * The WebSocket send path in main: the resolver's target, chain and expansion, exercised through
 * `wsTlsFor`/`wsMeta` on `ProjectHost` as well, against a real WebSocket server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import { createProject, createWsApi, createWsFolder, createWsRequest, entry } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { resolveWsSend } from '../src/main/ws-send.js';

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
    properties: { who: 'Ada', tenant: 'acme' },
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

function resolve(overrides: { readonly draft?: { url?: string } } = {}) {
  return resolveWsSend({
    project: project(),
    requestId: 'q-1',
    ...(overrides.draft !== undefined ? { draft: overrides.draft } : {}),
    scopes: { project: { who: 'Ada', tenant: 'acme', host: server.url }, global: {}, system: {} },
    resolveTarget: (api) => ({ url: api.url, source: 'api' }),
  });
}

describe('resolveWsSend', () => {
  it('applies the draft, expands the target under the environment, headers, query and subprotocols', () => {
    const resolved = resolve()!;
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

  it('applies the environment override, which beats the API own target', () => {
    const resolved = resolveWsSend({
      project: project(),
      requestId: 'q-1',
      scopes: { project: { who: 'Ada', tenant: 'acme' }, global: {}, system: {} },
      resolveTarget: () => ({ url: server.url, source: 'environment' }),
    })!;
    expect(resolved.input.serverUrl).toBe(server.url);
    expect(resolved.urlSource).toBe('environment');
  });

  it('resolves the auth chain: request inherits, so the folder above it wins over the API', () => {
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
    const resolved = resolveWsSend({
      project: p,
      requestId: 'q-1',
      scopes: { project: {}, global: {}, system: {} },
      resolveTarget: (api) => ({ url: api.url, source: 'api' }),
    })!;
    expect(resolved.auth).toEqual({ type: 'basic', username: 'u', passwordRef: 'folder-pass' });
  });

  it('reports an unresolved property in a draft, and returns undefined for an unknown request', () => {
    const drafted = resolve({ draft: { url: '/echo/${nope}' } })!;
    expect(drafted.unresolved.map((ref) => ref.name)).toEqual(['nope']);
    expect(
      resolveWsSend({
        project: project(),
        requestId: 'zz',
        scopes: { project: {}, global: {}, system: {} },
        resolveTarget: () => ({ url: '', source: 'api' }),
      }),
    ).toBeUndefined();
  });

  it('lets the request settings fall back through the project default and then preferences', () => {
    const withProjectDefault: Project = { ...project(), settings: { ...project().settings, defaultTimeoutMs: 5_000 } };
    const resolved = resolveWsSend({
      project: withProjectDefault,
      requestId: 'q-1',
      scopes: { project: { who: 'Ada', tenant: 'acme', host: server.url }, global: {}, system: {} },
      resolveTarget: (api) => ({ url: api.url, source: 'api' }),
    })!;
    expect(resolved.input.request.settings.handshakeTimeoutMs).toBe(5_000);
  });
});
