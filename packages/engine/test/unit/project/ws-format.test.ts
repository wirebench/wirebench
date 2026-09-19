/**
 * The WebSocket fourth of the `apis/` folder: a WebSocket API shares the directory with the
 * REST, gRPC and SOAP ones and says so with `kind: websocket`; each saved message goes to a
 * sibling file named by `wsMessageFileName`; and loading back produces the same model,
 * byte-stably.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSupportedKind } from '../../../src/project/schema.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import { tempProjectDir } from './fixture.js';

function emptyProject(): Project {
  return createProject('WS Project', { id: 'P1' });
}

function serializeProject(project: Project) {
  return projectFiles(project);
}

/** Writes a file map (as {@link projectFiles} produces) straight to a temp directory and loads it back. */
async function loadFrom(files: ReadonlyMap<string, string>) {
  const dir = await tempProjectDir();
  for (const [relative, content] of files) {
    const absolute = join(dir, ...relative.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  const result = await loadProject(dir);
  await rm(dir, { recursive: true, force: true });
  return result;
}

describe('round-trips a WebSocket API byte-identically', () => {
  it('round-trips a WebSocket API byte-identically', async () => {
    const request = createWsRequest('Feed', {
      id: 'r1',
      url: '/feed',
      subprotocols: ['chat.v2'],
      headers: [{ name: 'x-trace', value: '${trace}', enabled: true }],
      messages: [
        createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' }),
        createWsSavedMessage('Blob', { id: 'm2', format: 'binary', content: 'AAEC' }),
      ],
    });
    const project = {
      ...emptyProject(),
      wsApis: [createWsApi('Live', { id: 'a1', url: 'wss://live.example.test', requests: [request] })],
    };
    const first = serializeProject(project);
    expect([...first.keys()].filter((k) => k.startsWith('apis/Live/')).sort()).toEqual([
      'apis/Live/api.yaml',
      'apis/Live/requests/Feed.msg-Blob.b64',
      'apis/Live/requests/Feed.msg-Subscribe.json',
      'apis/Live/requests/Feed.request.yaml',
    ]);
    expect(first.get('apis/Live/api.yaml')).toContain('kind: websocket\n');
    const reloaded = await loadFrom(first);
    expect(reloaded.problems).toEqual([]);
    expect(reloaded.project.wsApis[0]?.requests[0]?.messages.map((m) => m.content)).toEqual(['{"op":"sub"}', 'AAEC']);
    expect(serializeProject(reloaded.project)).toEqual(first);
  });
});

describe('a project with no WebSocket API', () => {
  it('serialises exactly as before this task', () => {
    const petstore = createApi('Petstore', {
      id: 'A1',
      order: 0,
      baseUrl: 'https://petstore.test',
      requests: [createRestRequest('Health', { id: 'R0', url: '/health' })],
    });
    const greeter = createGrpcApi('Greeter', {
      id: 'G1',
      order: 1,
      target: 'localhost:50051',
      tls: false,
      requests: [createGrpcRequest('Health', { id: 'Q0', order: 0, service: 'S', method: 'M', message: '{}' })],
    });
    const withoutWs: Project = { ...emptyProject(), apis: [petstore], grpcApis: [greeter] };
    const withEmptyWs: Project = { ...withoutWs, wsApis: [] };

    const filesWithout = serializeProject(withoutWs);
    const filesWithEmpty = serializeProject(withEmptyWs);
    expect(filesWithEmpty).toEqual(filesWithout);
    for (const [key, value] of filesWithEmpty) {
      expect(key.toLowerCase()).not.toContain('websocket');
      expect(key.toLowerCase()).not.toContain('wsapi');
      expect(value.toLowerCase()).not.toContain('websocket');
      expect(value.toLowerCase()).not.toContain('wsapis');
    }
  });
});

describe('problems a damaged WebSocket API reports', () => {
  it('claims its message files: loading reports no stray-file problem', async () => {
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    const files = serializeProject(project);
    const { problems } = await loadFrom(files);
    expect(problems).toEqual([]);
  });

  it('loads a request whose message file is gone with an empty message', async () => {
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    const files = serializeProject(project);
    const withoutMessage = new Map(files);
    withoutMessage.delete('apis/Live/requests/Feed.msg-Subscribe.json');
    const { project: loaded, problems } = await loadFrom(withoutMessage);
    expect(loaded.wsApis[0]?.requests[0]?.messages[0]?.content).toBe('');
    expect(problems).toEqual([
      {
        code: 'missing-body',
        message: 'Request "Feed" has no message file; loaded with an empty message',
        file: 'apis/Live/requests/Feed.msg-Subscribe.json',
      },
    ]);
  });
});

describe('path safety of a WebSocket message slug', () => {
  it('makes serializeProject throw the path-safety error for an unsafe message slug', () => {
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('bad', { id: 'm1', slug: '../../etc', content: 'x' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    expect(() => serializeProject(project)).toThrow(/path/i);
  });

  it('makes serializeProject throw duplicate-slug for two messages with the same slug', () => {
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [
        createWsSavedMessage('One', { id: 'm1', slug: 'Same', content: 'a' }),
        createWsSavedMessage('Two', { id: 'm2', slug: 'Same', content: 'b' }),
      ],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    let error: unknown;
    try {
      serializeProject(project);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'duplicate-slug' });
  });
});

describe('renaming a WebSocket request', () => {
  it('yields the new slug paths and none of the old ones', () => {
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    const before = serializeProject(project);
    expect([...before.keys()].some((k) => k.includes('Feed.'))).toBe(true);

    const renamed = {
      ...emptyProject(),
      wsApis: [
        createWsApi('Live', {
          id: 'a1',
          requests: [{ ...request, name: 'Ticker', slug: 'Ticker' }],
        }),
      ],
    };
    const after = serializeProject(renamed);
    const afterKeys = [...after.keys()].filter((k) => k.startsWith('apis/Live/'));
    expect(afterKeys.some((k) => k.includes('Ticker.'))).toBe(true);
    expect(afterKeys.some((k) => k.includes('Feed.'))).toBe(false);
  });
});

describe('assertSupportedKind', () => {
  it('throws for an unsupported kind and accepts websocket', () => {
    expect(() => assertSupportedKind({ kind: 'graphql' }, 'apis/x/api.yaml')).toThrow(
      'apis/x/api.yaml is a "graphql" document, which this build cannot open',
    );
    expect(() => assertSupportedKind({ kind: 'websocket' }, 'apis/x/api.yaml')).not.toThrow();
  });
});
