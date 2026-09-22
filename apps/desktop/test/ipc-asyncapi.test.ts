// @vitest-environment node
/**
 * `api.importAsyncApi`, end to end over a real project host: the channel reads the document, maps
 * it into a WebSocket API, caches what it read under the API's folder and saves the project.
 *
 * Beside it, the wire half of the contract: zod strips keys a schema does not name, so each place a
 * contract link or a frame's check result crosses the IPC boundary is proved to survive the parse.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultFetchDocument, type FetchDocument, type WsFrame } from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { toWsFrameWire } from '../src/main/engine-wire.js';
import { ProjectHost } from '../src/main/project-host.js';
import { OpenApiImportService } from '../src/main/openapi-import.js';
import { updateWsRequest } from '../src/main/project-ws-mutations.js';
import {
  apiImportAsyncApiResponseSchema,
  wsFrameWireSchema,
  wsRequestWireSchema,
  wsSavedMessageWireSchema,
  type ProjectWire,
  type WsRequestWire,
} from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerApiChannels } = await import('../src/main/ipc/api.js');
type ApiChannelDeps = Parameters<typeof registerApiChannels>[0];

const fixtures = fileURLToPath(new URL('../../../packages/engine/test/fixtures/asyncapi/', import.meta.url));

const sender = { isDestroyed: () => false, send: vi.fn() };

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

async function value<T>(channel: string, payload: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  const result = (await handler({ sender }, payload)) as Envelope;
  if (!result.ok) throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

async function failure(channel: string, payload: unknown): Promise<{ code?: string }> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  const result = (await handler({ sender }, payload)) as Envelope;
  if (result.ok) throw new Error(`${channel} unexpectedly succeeded`);
  return result.error as { code?: string };
}

let root: string;
let projectDir: string;
let docPath: string;
const hosts = new Map<string, ProjectHost>();
let removed: string[];

function hostFor(projectId: string): ProjectHost {
  const host = hosts.get(projectId);
  if (host === undefined) throw new Error(`no project ${projectId}`);
  return host;
}

beforeEach(async () => {
  handlers.clear();
  hosts.clear();
  removed = [];
  root = mkdtempSync(join(tmpdir(), 'wirebench-asyncapi-'));
  projectDir = join(root, 'Chat');
  await mkdir(projectDir, { recursive: true });
  // The document and the schema file it references sit inside the project, so the path check passes.
  // The cache keeps a document's own file name, so the root is copied as `asyncapi.yaml`.
  docPath = join(projectDir, 'asyncapi.yaml');
  // A second WebSocket server, `staging`, that the channel is also served on, so a non-default
  // server choice has something to pick.
  const fixture = await readFile(join(fixtures, 'chat-3.0.yaml'), 'utf8');
  await writeFile(
    docPath,
    fixture
      .replace(
        '  broker:\n',
        "  staging:\n    host: staging.chat.example.test\n    pathname: /live\n    protocol: wss\n    security:\n      - $ref: '#/components/securitySchemes/bearerAuth'\n  broker:\n",
      )
      .replace(
        "      - $ref: '#/servers/public'\n",
        "      - $ref: '#/servers/public'\n      - $ref: '#/servers/staging'\n",
      ),
  );
  await copyFile(join(fixtures, 'schemas.yaml'), join(projectDir, 'schemas.yaml'));

  const host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(projectDir, 'project'), name: 'Chat' });
  hosts.set('p1', host);

  // `https://slow.test/` never answers until the import is aborted, so a cancel has something to stop.
  const real = createDefaultFetchDocument();
  const fetchDocument: FetchDocument = (location, signal) =>
    location.startsWith('https://slow.test/')
      ? new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The import was cancelled', 'AbortError'));
          });
        })
      : real(location, signal);
  const imports = new OpenApiImportService({ fetchDocument });
  const unused = vi.fn();
  const deps: ApiChannelDeps = {
    router: {
      addApi: unused,
      addGrpcApi: unused,
      importAsyncApi: (projectId, input) => hostFor(projectId).importAsyncApi(input),
      apiDefinitionDocuments: unused,
      apiDefinitionText: unused,
      exportApiDefinitionTo: unused,
      grpcDefinition: unused,
      grpcFields: unused,
      grpcRefresh: unused,
      grpcSample: unused,
    },
    imports,
    asyncApiImports: imports,
    addProject: async (name) => {
      const created = new ProjectHost(
        new EngineService(),
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        new DialogPicks(),
      );
      await created.create({ dir: join(root, name), name });
      hosts.set('p-new', created);
      return { projectId: 'p-new' };
    },
    removeProject: (projectId) => {
      removed.push(projectId);
      return Promise.resolve();
    },
    projectDirs: () => [projectDir],
    picks: new DialogPicks(),
  };
  registerApiChannels(deps);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Imported {
  readonly projectId: string;
  readonly apiId: string;
  readonly project: ProjectWire;
  readonly summary: { readonly requests: number; readonly skipped: readonly { where: string; reason: string }[] };
}

describe('api.importAsyncApi', () => {
  it('adds one WebSocket API, caches its documents and reports the skipped Kafka channel', async () => {
    const response = await value<Imported>('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: docPath },
      token: 'tok-1',
    });

    expect(apiImportAsyncApiResponseSchema.safeParse(response).success).toBe(true);
    expect(response.projectId).toBe('p1');
    const snapshot = hostFor('p1').snapshot() as ProjectWire;
    expect(snapshot.wsApis).toHaveLength(1);
    const api = snapshot.wsApis[0];
    expect(api?.id).toBe(response.apiId);
    expect(api?.definition).toEqual({ kind: 'asyncapi', source: docPath, cache: true });

    const definitionDir = join(projectDir, 'project', 'apis', api?.slug ?? '', 'definition');
    expect((await readdir(definitionDir)).sort()).toEqual(['asyncapi.yaml', 'manifest.yaml', 'schemas.yaml']);

    expect(response.summary.requests).toBeGreaterThan(0);
    expect(response.summary.skipped.some((entry) => /audit/.test(entry.where) && /kafka/i.test(entry.reason))).toBe(
      true,
    );

    // The contract links reach the renderer: the request's channel, and each message's source.
    const requests = snapshot.wsRequests.filter((request) => request.apiId === api?.id);
    expect(requests.some((request) => request.contract?.channel === 'userChat')).toBe(true);
    expect(requests.flatMap((request) => request.messages).some((message) => message.contract !== undefined)).toBe(
      true,
    );
    // Progress went out under the dialog's token.
    expect(sender.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ token: 'tok-1' }));
  });

  it("keeps the scheme's auth block with no secret in it, and no secret in any project file", async () => {
    const response = await value<Imported>('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: docPath },
    });
    const api = (hostFor('p1').snapshot() as ProjectWire).wsApis.find((one) => one.id === response.apiId);
    // The bearer scheme becomes the API's auth, with the token left for the user to fill in.
    expect(api?.auth).toMatchObject({ type: 'bearer' });
    const token = (api?.auth as { token?: string } | undefined)?.token;
    expect(token === undefined || token === '').toBe(true);

    const dir = join(projectDir, 'project');
    const files = (await readdir(dir, { recursive: true })).filter(
      (file) => !file.includes('definition') && /\.(ya?ml|json)$/.test(file),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      expect(text).not.toMatch(/\b(token|password|secret|clientSecret):\s*['"]?[^\s'"{}]+/i);
    }
  });

  it('dials a non-default WebSocket server when one is chosen', async () => {
    const response = await value<Imported & { summary: { server?: string } }>('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: docPath },
      server: 'staging',
    });
    expect(response.summary.server).toBe('staging');
    const api = (hostFor('p1').snapshot() as ProjectWire).wsApis.find((one) => one.id === response.apiId);
    expect(api?.url).toContain('staging.chat.example.test');
    expect(api?.url).not.toContain('{region}');
  });

  it('stops on api.cancelImport, failing as aborted and adding nothing', async () => {
    const pending = failure('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'https://slow.test/asyncapi.yaml' },
      token: 'tok-cancel',
    });
    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ token: 'tok-cancel' }));
    });
    const cancelled = await value<{ cancelled: boolean }>('api.cancelImport', { token: 'tok-cancel' });
    expect(cancelled.cancelled).toBe(true);
    const error = await pending;
    expect(error.code).toBe('aborted');
    expect((hostFor('p1').snapshot() as ProjectWire).wsApis).toHaveLength(0);
  });

  it('passes the server choice to the mapping, and refuses one the document does not have', async () => {
    const error = await failure('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: docPath },
      server: 'nowhere',
    });
    expect(error.code).toBe('asyncapi-server-unknown');
    expect((hostFor('p1').snapshot() as ProjectWire).wsApis).toHaveLength(0);
  });

  it('creates a project for a newProjectName target, like a .proto import', async () => {
    const response = await value<Imported>('api.importAsyncApi', {
      target: { newProjectName: 'Fresh' },
      source: { kind: 'file', path: docPath },
      name: 'Chat API',
      cache: false,
    });
    expect(response.projectId).toBe('p-new');
    const snapshot = hostFor('p-new').snapshot() as ProjectWire;
    expect(snapshot.wsApis.map((api) => api.name)).toEqual(['Chat API']);
    expect(existsSync(join(root, 'Fresh', 'apis', snapshot.wsApis[0]?.slug ?? '', 'definition'))).toBe(false);
    expect(removed).toEqual([]);
  });

  it('refuses a file outside every project before creating anything', async () => {
    const error = await failure('api.importAsyncApi', {
      target: { newProjectName: 'Fresh' },
      source: { kind: 'file', path: join(fixtures, 'chat-3.0.yaml') },
    });
    expect(error.code).toBe('import-path-refused');
    expect(hosts.has('p-new')).toBe(false);
  });
});

describe('contract on the wire', () => {
  it("keeps a frame's contract through the frame schema, not-checked included", () => {
    const frame: WsFrame = {
      index: 3,
      direction: 'received',
      opcode: 'text',
      at: 12,
      size: 2,
      text: '{}',
      contract: {
        status: 'violation',
        message: 'chatMessage',
        problems: [{ path: '/text', keyword: 'required', message: 'is required' }],
      },
    };
    expect(wsFrameWireSchema.parse(toWsFrameWire(frame)).contract).toEqual(frame.contract);
    const notChecked = { ...frame, contract: { status: 'not-checked' as const, reason: 'out of time' } };
    expect(wsFrameWireSchema.parse(toWsFrameWire(notChecked)).contract).toEqual(notChecked.contract);
  });

  it("keeps a request's contract and orphaned flag, and a saved message's contract", () => {
    const message = {
      id: 'm1',
      name: 'sendChat',
      slug: 'sendChat',
      format: 'text' as const,
      content: '{}',
      contract: { message: 'sendChat', generated: '{}' },
    };
    expect(wsSavedMessageWireSchema.parse(message).contract).toEqual(message.contract);
    const request: WsRequestWire = {
      kind: 'websocket',
      id: 'r1',
      apiId: 'a1',
      name: 'userChat',
      slug: 'userChat',
      order: 0,
      url: '/chat',
      query: [],
      headers: [],
      subprotocols: [],
      auth: { type: 'inherit' },
      settings: {},
      messages: [message],
      contract: { channel: 'userChat' },
      orphaned: true,
    };
    const parsed = wsRequestWireSchema.parse(request);
    expect(parsed.contract).toEqual({ channel: 'userChat' });
    expect(parsed.orphaned).toBe(true);
    expect(parsed.messages[0]?.contract).toEqual(message.contract);
  });

  it("keeps main's message contract across a patch that leaves it out", async () => {
    await value<Imported>('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: docPath },
    });
    const host = hostFor('p1');
    const project = (host as unknown as { require(): { project: Parameters<typeof updateWsRequest>[0] } }).require()
      .project;
    type Folder = {
      readonly folders: readonly Folder[];
      readonly requests: (typeof project.wsApis)[number]['requests'];
    };
    const all = (container: Folder): Folder['requests'] => [
      ...container.requests,
      ...container.folders.flatMap((folder) => all(folder)),
    ];
    const api = project.wsApis[0];
    const request =
      api === undefined ? undefined : all(api).find((candidate) => candidate.messages.some((m) => m.contract));
    if (request === undefined) throw new Error('no request with a contract message');
    const patched = updateWsRequest(project, request.id, {
      messages: request.messages.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        format: m.format,
        content: m.content,
      })),
    });
    const patchedApi = patched.project.wsApis[0];
    const after =
      patchedApi === undefined ? undefined : all(patchedApi).find((candidate) => candidate.id === request.id);
    expect(after?.messages.map((m) => m.contract)).toEqual(request.messages.map((m) => m.contract));
  });
});
