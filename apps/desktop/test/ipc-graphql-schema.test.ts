// @vitest-environment node
/**
 * The GraphQL schema channels in main (#77): `request.graphqlIntrospect` against the test server's
 * `/graphql`, quiet (no History entry), and `api.importGraphqlSchema` from an SDL file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import type { HistoryService } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { registerRestApiChannels, registerRestRequestChannels } from '../src/main/kinds/rest/ipc.js';
import { tableInto } from './helpers/ipc-table.js';
import { createHostState } from '../src/main/host/host-state.js';

const hostState = createHostState();

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers, hostState.redactor);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: {} }, payload);
}

let server: TestRestServer;
let root: string;

beforeAll(async () => {
  server = await startTestRestServer();
  root = mkdtempSync(join(tmpdir(), 'wirebench-graphql-ipc-'));
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function seeded(path: string): Project {
  const api = createApi('Shop', {
    id: 'api-1',
    baseUrl: server.url,
    requests: [createRestRequest('Products', { id: 'req-1', method: 'POST', url: path })],
  });
  return { ...createProject('Demo', { id: 'p1' }), containers: { rest: [api] } };
}

/** The channels over `model`, with a store and a History that only remember what they are given. */
function harness(model: Project) {
  const stored: { apiId: string; sdl: string; source: string }[] = [];
  const recorded: unknown[] = [];
  const setGraphqlSchema = (apiId: string, sdl: string, source: string) => {
    stored.push({ apiId, sdl, source });
    return Promise.resolve({ source, fetchedAt: '2026-10-13T00:00:00.000Z' });
  };
  const deps: RequestChannelDeps = {
    hostState,
    project: {
      projectId: () => 'p1',
      restMeta: () => undefined,
      runContextFor: () => ({ project: model, projectDir: root, globals: {} }),
      setGraphqlSchema,
    } as unknown as RequestChannelDeps['project'],
    history: {
      recordRestSend: (_projectId: string, record: unknown) => {
        recorded.push(record);
        return Promise.resolve({});
      },
    } as unknown as HistoryService,
    secretsFor: () => () => Promise.resolve(undefined),
  };
  handlers.clear();
  registerRestRequestChannels(table, new EngineService(), deps);
  registerRestApiChannels(table, {
    router: { setGraphqlSchema, clearGraphqlSchema: () => Promise.resolve() },
    projectDirs: () => [root],
    picks: undefined,
  } as never);
  return { stored, recorded };
}

describe('fetching a GraphQL schema', () => {
  it('stores the SDL of the introspection answer, and records no History entry', async () => {
    const { stored, recorded } = harness(seeded('/graphql'));

    const result = await invoke('request.graphqlIntrospect', { requestId: 'req-1', apiId: 'api-1' });

    expect(result).toMatchObject({ ok: true, value: { source: `${server.url}/graphql` } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.sdl).toContain('product(id: ID!)');
    expect(recorded).toEqual([]);
    const sent = server.requests.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(Buffer.from(sent.body).toString('utf8')).toContain('__schema');
  });

  it('refuses an answer that is not JSON, and stores nothing', async () => {
    const { stored } = harness(seeded('/echo-text'));

    const result = await invoke('request.graphqlIntrospect', { requestId: 'req-1', apiId: 'api-1' });

    expect(result).toMatchObject({ ok: false, error: { code: 'graphql-schema-invalid' } });
    expect(stored).toEqual([]);
  });
});

describe('importing a GraphQL schema', () => {
  it('stores an SDL file under its own name', async () => {
    const { stored } = harness(seeded('/graphql'));
    const path = join(root, 'shop.graphql');
    writeFileSync(path, 'type Query { ping: String }\n');

    const result = await invoke('api.importGraphqlSchema', { apiId: 'api-1', path });

    expect(result).toMatchObject({ ok: true, value: { source: 'shop.graphql' } });
    expect(stored[0]!.sdl).toContain('ping: String');
  });

  it('refuses a file that is not a schema', async () => {
    const { stored } = harness(seeded('/graphql'));
    const path = join(root, 'broken.graphql');
    writeFileSync(path, 'type Query {');

    expect(await invoke('api.importGraphqlSchema', { apiId: 'api-1', path })).toMatchObject({
      ok: false,
      error: { code: 'graphql-schema-invalid' },
    });
    expect(stored).toEqual([]);
  });
});
