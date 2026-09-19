/**
 * `saveProject` for a WebSocket API: its saved-message sibling files must be recognised as
 * managed (`listApiTreeFiles` in `save.ts`), the same way a REST raw body or a gRPC message is, so
 * a removed message, a renamed request or a message whose format changed leaves no orphan file
 * behind — while a hand-placed file that merely *looks* like a message sibling, but names no real
 * request, is left alone.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { APIS_DIR } from '../../../src/project/paths.js';
import { saveProject } from '../../../src/project/save.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import { listTree, tempProjectDir } from './fixture.js';

function emptyProject(): Project {
  return createProject('WS Save Project', { id: 'P1' });
}

describe('saveProject for a WebSocket API', () => {
  it('deletes a removed message file and keeps the other', async () => {
    const dir = await tempProjectDir();
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [
        createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' }),
        createWsSavedMessage('Blob', { id: 'm2', format: 'binary', content: 'AAEC' }),
      ],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    await saveProject(project, dir);
    expect(await listTree(dir)).toContain('apis/Live/requests/Feed.msg-Subscribe.json');
    expect(await listTree(dir)).toContain('apis/Live/requests/Feed.msg-Blob.b64');

    const withOneMessage = {
      ...emptyProject(),
      wsApis: [
        createWsApi('Live', {
          id: 'a1',
          requests: [{ ...request, messages: [request.messages[0]!] }],
        }),
      ],
    };
    const result = await saveProject(withOneMessage, dir);
    expect(result.removed).toContain('apis/Live/requests/Feed.msg-Blob.b64');
    const after = await listTree(dir);
    expect(after).toContain('apis/Live/requests/Feed.msg-Subscribe.json');
    expect(after).not.toContain('apis/Live/requests/Feed.msg-Blob.b64');
    await rm(dir, { recursive: true, force: true });
  });

  it('renaming the request slug leaves no Feed.* file behind', async () => {
    const dir = await tempProjectDir();
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    await saveProject(project, dir);

    const renamed = {
      ...emptyProject(),
      wsApis: [
        createWsApi('Live', {
          id: 'a1',
          requests: [{ ...request, name: 'Ticker', slug: 'Ticker' }],
        }),
      ],
    };
    await saveProject(renamed, dir);
    const after = await listTree(dir);
    expect(after.some((path) => path.includes('Feed.'))).toBe(false);
    expect(after).toContain('apis/Live/requests/Ticker.request.yaml');
    expect(after).toContain('apis/Live/requests/Ticker.msg-Subscribe.json');
    await rm(dir, { recursive: true, force: true });
  });

  it('changing a message from JSON to plain text removes the old extension', async () => {
    const dir = await tempProjectDir();
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    await saveProject(project, dir);
    expect(await listTree(dir)).toContain('apis/Live/requests/Feed.msg-Subscribe.json');

    const asText = {
      ...emptyProject(),
      wsApis: [
        createWsApi('Live', {
          id: 'a1',
          requests: [{ ...request, messages: [{ ...request.messages[0]!, content: 'plain text, not json' }] }],
        }),
      ],
    };
    const result = await saveProject(asText, dir);
    expect(result.removed).toContain('apis/Live/requests/Feed.msg-Subscribe.json');
    const after = await listTree(dir);
    expect(after).not.toContain('apis/Live/requests/Feed.msg-Subscribe.json');
    expect(after).toContain('apis/Live/requests/Feed.msg-Subscribe.txt');
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves an unrelated hand-placed file alone', async () => {
    const dir = await tempProjectDir();
    const request = createWsRequest('Feed', {
      id: 'r1',
      messages: [createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' })],
    });
    const project = { ...emptyProject(), wsApis: [createWsApi('Live', { id: 'a1', requests: [request] })] };
    await saveProject(project, dir);
    await mkdir(join(dir, APIS_DIR, 'Live', 'requests'), { recursive: true });
    await writeFile(join(dir, APIS_DIR, 'Live', 'requests', 'notes.msg-x.txt'), 'not owned by any request');

    const result = await saveProject(project, dir);
    expect(result.removed).toEqual([]);
    expect(await listTree(dir)).toContain('apis/Live/requests/notes.msg-x.txt');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('an existing REST/gRPC save still round-trips unchanged', () => {
  it('saves and loads a project mixing REST and gRPC APIs untouched by the WebSocket change', async () => {
    const dir = await tempProjectDir();
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
    const project: Project = { ...emptyProject(), apis: [petstore], grpcApis: [greeter] };
    const result = await saveProject(project, dir);
    expect(result.removed).toEqual([]);
    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded.apis.map((a) => a.id)).toEqual(['A1']);
    expect(loaded.grpcApis.map((a) => a.id)).toEqual(['G1']);
    await rm(dir, { recursive: true, force: true });
  });
});
