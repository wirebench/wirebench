import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInterface,
  createProject,
  createRequest,
  DEFAULT_REQUEST_PROPERTIES,
  type Project,
  type PropertyScopes,
  type SoapRequestDef,
} from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import type { RecordSendInput } from '../src/main/history-service.js';
import { registerRequestChannels, toSendDeps, type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { PreflightResult } from '../src/main/expansion-preflight.js';
import { wrapHandler } from '../src/main/ipc/envelope.js';
import { ExchangeRegistry } from '../src/main/send/exchange.js';
import { channels } from '../src/shared/ipc.js';

describe('request.* IPC validation', () => {
  it('rejects a malformed request.send payload with ipc-invalid-request', async () => {
    const wrapped = wrapHandler(channels.request.send, () => Promise.reject(new Error('never reached')));

    const result = await wrapped({ sendId: 'x' /* missing `input` */ });

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('rejects a request.send payload whose input.soapVersion is invalid', async () => {
    const wrapped = wrapHandler(channels.request.send, () => Promise.reject(new Error('never reached')));

    const result = await wrapped({
      sendId: 'x',
      input: { endpoint: 'http://example.test', envelopeXml: '<a/>', soapVersion: '2.0' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('returns cancelled: false for an unknown sendId without touching the engine', async () => {
    const registry = new ExchangeRegistry();
    const cancelSpy = vi.spyOn(registry, 'cancel');
    const wrapped = wrapHandler(channels.request.cancel, (request) => Promise.resolve(registry.cancel(request.sendId)));

    const result = await wrapped({ sendId: 'never-sent' });

    expect(result).toEqual({ ok: true, value: { cancelled: false } });
    expect(cancelSpy).toHaveBeenCalledWith('never-sent');
  });

  it('rejects a malformed request.generate payload', async () => {
    const service = new EngineService();
    const wrapped = wrapHandler(channels.request.generate, (request) => Promise.resolve(service.generate(request)));

    const result = await wrapped({ interfaceId: 'iface-1' /* missing bindingName/operationName */ });

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('maps an unknown interfaceId to the engine error code via the envelope', async () => {
    const service = new EngineService();
    const wrapped = wrapHandler(channels.request.generate, (request) => Promise.resolve(service.generate(request)));

    const result = await wrapped({ interfaceId: 'does-not-exist', bindingName: '{ns}B', operationName: 'Op' });

    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-interface' } });
  });
});

// `registerRequestChannels` binds through `ipcMain.handle`; the stub below captures the bound
// handlers so the registration itself (not a re-spelled copy of it) is what these tests drive.
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

/** A real file, used as the parent of an impossible dump path. */
const existingFile = join(mkdtempSync(join(tmpdir(), 'wirebench-dump-fail-')), 'blocker');
writeFileSync(existingFile, 'not a directory', 'utf8');

const scopes: PropertyScopes = { project: { stage: 'dev' }, global: {}, env: { who: 'ada' } };

const preflight: PreflightResult = {
  endpoint: 'http://dev.test/soap',
  endpointSource: 'environment',
  auth: { source: 'none', type: 'none' },
  wsa: { enabled: false },
  unresolved: [{ expr: '${#Env#missing}', code: 'missing', start: 0, end: 15, field: 'envelopeXml' }],
};

/**
 * The recreate/cURL half of the project surface, which the send/preflight tests below never
 * exercise — every call throws so an accidental use is loud rather than silently `undefined`.
 */
const noActionSupport = {
  requestSource: (): never => {
    throw new Error('requestSource is not stubbed in this test');
  },
  projectMutate: (): never => {
    throw new Error('projectMutate is not stubbed in this test');
  },
  dumpFileFor: (): undefined => undefined,
  // No saved SOAP request behind these sends.
  endpointFor: (): undefined => undefined,
};

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

interface OkServer {
  readonly url: string;
  /** Every request body received, in order. */
  readonly bodies: string[];
  readonly contentTypes: string[];
  close(): Promise<void>;
}

/** What the server answers: a SOAP envelope, so the exchange carries no `not-soap` problem. */
const OK =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ok/></soapenv:Body></soapenv:Envelope>';

/** Answers every POST with {@link OK}, keeping what it was sent. */
async function startOkServer(): Promise<OkServer> {
  const bodies: string[] = [];
  const contentTypes: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('latin1'));
      contentTypes.push(req.headers['content-type'] ?? '');
      // `/slow` answers after half a second: longer than a 100 ms timeout.
      setTimeout(
        () => {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(OK);
        },
        req.url === '/slow' ? 500 : 0,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    bodies,
    contentTypes,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** A project whose `req-1` the sends below go through; its endpoint is the renderer's, whatever it saves. */
function seeded(extra: Partial<SoapRequestDef> = {}): Project {
  const request: SoapRequestDef = {
    ...createRequest('Req', { id: 'req-1', envelopeXml: '<a/>', soapVersion: '1.1' }),
    endpointUrl: 'http://127.0.0.1:1/saved',
    ...extra,
  };
  const iface = createInterface('Svc', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/x?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [request] }],
  });
  return { ...createProject('P', { id: 'p1' }), properties: { stage: 'dev' }, containers: { soap: [iface] } };
}

/** The project surface a send through the engine reads, over `model`. */
function stubProject(model: Project) {
  return {
    scopesFor: () => scopes,
    preflight: () => preflight,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
    ...noActionSupport,
  };
}

describe('plaintext credentials never validate', () => {
  it('rejects a definition.import whose auth carries a plaintext password', () => {
    const parsed = channels.definition.import.request.safeParse({
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      options: { auth: { username: 'alice', passwordRef: 'sec_1', password: 's3cret!' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a project.addInterface whose auth carries a plaintext password', () => {
    const parsed = channels.project.addInterface.request.safeParse({
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1', password: 's3cret!' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the same payload once the plaintext password is gone', () => {
    const parsed = channels.project.addInterface.request.safeParse({
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('toSendDeps', () => {
  it('lends the workspace cookie jar to every send, and none when the channel has none', () => {
    const cookies = () => ({ cookiesFor: () => [], remember: () => [] });
    const project = stubProject(seeded({ envelopeXml: '<a/>' }));
    expect(toSendDeps(new EngineService(), { project, cookies }).cookies).toBe(cookies);
    expect(toSendDeps(new EngineService(), { project }).cookies).toBeUndefined();
  });
});

describe('registerRequestChannels', () => {
  let server: OkServer;

  beforeEach(async () => {
    handlers.clear();
    server = await startOkServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("expands every send against its own project's scopes, and an ad-hoc one against the ad-hoc scopes", async () => {
    const model = seeded({ envelopeXml: '<a>${#Project#stage}</a>' });
    const runContextFor = vi.fn(() => ({ project: model, projectDir: '/tmp/none', globals: {} }));
    const adHoc: PropertyScopes = { project: {}, global: { only: 'globals' }, env: {} };
    registerRequestChannels(new EngineService(), {
      project: { ...stubProject(model), runContextFor },
      adHocScopes: () => adHoc,
    });

    const result = await invoke('request.send', {
      sendId: 'send-1',
      requestId: 'req-1',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a>${#Project#stage}</a>', soapVersion: '1.1' },
    });

    expect(result).toMatchObject({ ok: true });
    // Resolved for the request's own project: the router picks the host from the request id.
    expect(runContextFor).toHaveBeenCalledWith('req-1', undefined);
    expect(server.bodies.at(-1)).toBe('<a>dev</a>');

    // A send with no request behind it belongs to no project, so it expands against the
    // ad-hoc scopes (globals and the process env) rather than being routed anywhere.
    await invoke('request.send', {
      sendId: 'send-2',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a>${#Global#only}</a>', soapVersion: '1.1' },
    });
    expect(server.bodies.at(-1)).toBe('<a>globals</a>');
    expect(runContextFor).toHaveBeenCalledTimes(1);

    // The ad-hoc scopes are all it reads: the project's own properties are not among them.
    const before = server.bodies.length;
    const refused = await invoke('request.send', {
      sendId: 'send-3',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a>${#Project#stage}</a>', soapVersion: '1.1' },
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'unresolved-properties' } });
    expect(server.bodies.length).toBe(before);
  });

  it('returns secret-missing (not an unhandled rejection) when auth references a deleted ref', async () => {
    // The store no longer holds the ref the project's auth points at — a password cleared from
    // the keychain while the project still references it.
    const model = seeded({ auth: { type: 'basic', username: 'alice', passwordRef: 'sec_deleted' } });
    registerRequestChannels(new EngineService(() => Promise.resolve(undefined)), {
      project: { ...stubProject(model), projectId: () => undefined },
      getSecret: () => Promise.resolve(undefined),
    });

    const result = await invoke('request.send', {
      sendId: 'send-missing',
      requestId: 'req-1',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'secret-missing' } });
  });

  it('answers request.preflight from the project service', async () => {
    const project = {
      scopesFor: vi.fn().mockReturnValue(scopes),
      preflight: vi.fn().mockReturnValue(preflight),
      requestMeta: vi.fn().mockReturnValue(undefined),
      projectId: vi.fn().mockReturnValue(undefined),
      ...noActionSupport,
    };
    registerRequestChannels(new EngineService(), { project });

    const result = await invoke('request.preflight', { requestId: 'req-1' });

    expect(project.preflight).toHaveBeenCalledWith('req-1');
    expect(result).toEqual({ ok: true, value: preflight });
  });

  it('rejects a malformed request.preflight payload', async () => {
    registerRequestChannels(new EngineService(), {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
      },
    });

    expect(await invoke('request.preflight', {})).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });
});

describe('request.send applies the saved request properties', () => {
  let server: OkServer;

  beforeEach(async () => {
    handlers.clear();
    server = await startOkServer();
  });

  afterEach(async () => {
    await server.close();
  });

  /** The `request.*` channels over `model`, with `project` laid over the stub's members. */
  function registerOver(
    model: Project,
    project: Record<string, unknown> = {},
    extra: Partial<RequestChannelDeps> = {},
  ) {
    registerRequestChannels(new EngineService(), {
      project: { ...stubProject(model), ...project },
      ...extra,
    });
  }

  const send = (sendId: string, requestId: string | undefined = 'req-1') =>
    invoke('request.send', {
      sendId,
      ...(requestId !== undefined ? { requestId } : {}),
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<raw/>', soapVersion: '1.1' },
    }) as Promise<{ ok: boolean; value: { problems: { code: string }[] } }>;

  it("sends the renderer's envelope with the saved request's properties applied", async () => {
    const recordSend = vi.fn<(projectId: string, record: RecordSendInput) => Promise<undefined>>(() =>
      Promise.resolve(undefined),
    );
    registerOver(
      seeded({
        envelopeXml: '<saved/>',
        properties: { ...DEFAULT_REQUEST_PROPERTIES, encoding: 'ISO-8859-1', timeoutMs: 100 },
      }),
      {},
      { history: { recordSend } as never },
    );

    await send('send-mapped');

    // The editor's envelope, with the saved request's encoding on the wire.
    expect(server.bodies.at(-1)).toBe('<raw/>');
    expect(server.contentTypes.at(-1)).toMatch(/charset=ISO-8859-1/i);
    const [, record] = recordSend.mock.calls[0]!;
    expect(record.input).toMatchObject({ endpoint: `${server.url}/soap`, envelopeXml: '<raw/>', soapVersion: '1.1' });
    expect(record.input.headers?.['Content-Type']).toMatch(/charset=ISO-8859-1/i);

    // And the saved timeout: a response slower than 100 ms is not waited for.
    const slow = await invoke('request.send', {
      sendId: 'send-slow',
      requestId: 'req-1',
      input: { endpoint: `${server.url}/slow`, envelopeXml: '<raw/>', soapVersion: '1.1' },
    });
    expect(slow).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('sends an ad-hoc request exactly as the renderer built it', async () => {
    registerOver(seeded());

    await send('send-adhoc', undefined);

    expect(server.bodies.at(-1)).toBe('<raw/>');
  });

  it("writes the response body to the request's dump file, resolving it against the project dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    registerOver(seeded(), { dumpFileFor: () => ({ path: join('dumps', 'last.xml'), projectDir: dir }) });

    const result = await send('send-dump');

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([]);
    expect(readFileSync(join(dir, 'dumps', 'last.xml'), 'utf8')).toBe(OK);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a dump file whose relative path traverses outside the project folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    registerOver(seeded(), { dumpFileFor: () => ({ path: join('..', '..', 'escaped.xml'), projectDir: dir }) });

    const result = await send('send-dump-traversal');

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-outside-project' })]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an absolute dump file path outside the project folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'wirebench-outside-'));
    registerOver(seeded(), { dumpFileFor: () => ({ path: join(outsideDir, 'out.xml'), projectDir: dir }) });

    const result = await send('send-dump-absolute');

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-outside-project' })]);
    expect(existsSync(join(outsideDir, 'out.xml'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('allows an absolute dump file path outside the project when it was picked via Browse…', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'wirebench-outside-'));
    const outsidePath = join(outsideDir, 'picked.xml');
    registerOver(
      seeded(),
      { dumpFileFor: () => ({ path: outsidePath, projectDir: dir }) },
      { dialogPicks: { hasWrite: (path) => path === outsidePath } },
    );

    const result = await send('send-dump-picked');

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([]);
    expect(readFileSync(outsidePath, 'utf8')).toBe(OK);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses an absolute dump file path that was only picked as an attachment read source', async () => {
    // Adversarial case for finding 2 (fix round 3): a file chosen in the attachments "Add"
    // dialog (a read pick) must not become a legal Dump File write target. Before the
    // read/write split, `DumpFilePicks` consulted the same generalised set `pickFiles`
    // populated, so this exact scenario would have been wrongly allowed.
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'wirebench-outside-'));
    const outsidePath = join(outsideDir, 'attached-not-dumped.xml');
    registerOver(
      seeded(),
      { dumpFileFor: () => ({ path: outsidePath, projectDir: dir }) },
      // `hasWrite` never returns true for this path: it was only ever offered as a read pick.
      { dialogPicks: { hasWrite: () => false } },
    );

    const result = await send('send-dump-read-pick-only');

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-outside-project' })]);
    expect(existsSync(outsidePath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('reports a dump-failed problem instead of failing the send', async () => {
    registerOver(seeded(), {
      // A path whose parent is a file, so `mkdir` cannot create it.
      // The project dir is the filesystem root the temp file lives on, so the containment
      // check passes on every platform ('/' would be the *current drive*'s root on Windows,
      // which need not be the drive holding the temp folder).
      dumpFileFor: () => ({ path: join(existingFile, 'nested', 'out.xml'), projectDir: parse(existingFile).root }),
    });

    const result = await send('send-dump-fail');

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-failed' })]);
  });
});
