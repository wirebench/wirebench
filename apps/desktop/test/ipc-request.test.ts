import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyScopes } from '@wirebench/engine';
import type { RequestSendRequest } from '../src/shared/wire-types.js';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels } from '../src/main/ipc/request.js';
import type { PreflightResult } from '../src/main/expansion-preflight.js';
import { wrapHandler } from '../src/main/ipc/envelope.js';
import { channels } from '../src/shared/ipc.js';

describe('request.* IPC validation', () => {
  it('rejects a malformed request.send payload with ipc-invalid-request', async () => {
    const service = new EngineService();
    const wrapped = wrapHandler(channels.request.send, (request) => service.send(request));

    const result = await wrapped({ sendId: 'x' /* missing `input` */ });

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('rejects a request.send payload whose input.soapVersion is invalid', async () => {
    const service = new EngineService();
    const wrapped = wrapHandler(channels.request.send, (request) => service.send(request));

    const result = await wrapped({
      sendId: 'x',
      input: { endpoint: 'http://example.test', envelopeXml: '<a/>', soapVersion: '2.0' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('returns cancelled: false for an unknown sendId without touching the engine', async () => {
    const service = new EngineService();
    const cancelSpy = vi.spyOn(service, 'cancel');
    const wrapped = wrapHandler(channels.request.cancel, (request) => Promise.resolve(service.cancel(request.sendId)));

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
  buildLiveSendInput: (): never => {
    throw new Error('buildLiveSendInput is not stubbed in this test');
  },
  mutate: (): never => {
    throw new Error('mutate is not stubbed in this test');
  },
  // No saved request behind these sends, so the property mapping is a pass-through.
  sendInputFor: (): undefined => undefined,
  dumpFileFor: (): undefined => undefined,
};

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
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
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1', password: 's3cret!' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the same payload once the plaintext password is gone', () => {
    const parsed = channels.project.addInterface.request.safeParse({
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('registerRequestChannels', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("passes the project service's property scopes into every send", async () => {
    const engine = new EngineService();
    const send = vi.spyOn(engine, 'send').mockResolvedValue({
      sendId: 'send-1',
      durationMs: 1,
      http: {
        status: 200,
        statusText: 'OK',
        headers: {},
        rawHeaders: [],
        bodyBase64: '',
        rawBodyBase64: '',
        rawRequestBase64: '',
        rawResponseBase64: '',
        truncated: false,
        httpVersion: '1.1',
        timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
        redirects: [],
        request: { url: 'http://dev.test/soap', method: 'POST', headers: {} },
      },
      problems: [],
    });
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
      },
    });

    const result = await invoke('request.send', {
      sendId: 'send-1',
      input: { endpoint: 'http://dev.test/soap', envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sendId: 'send-1' }), { scopes, showSecrets: false });
  });

  it('returns secret-missing (not an unhandled rejection) when auth references a deleted ref', async () => {
    // The store no longer holds the ref the project's auth points at — a password cleared from
    // the keychain while the project still references it.
    const engine = new EngineService(() => Promise.resolve(undefined));
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => ({ type: 'basic', username: 'alice', passwordRef: 'sec_deleted' }),
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
      },
    });

    const result = await invoke('request.send', {
      sendId: 'send-missing',
      requestId: 'req-1',
      input: { endpoint: 'http://dev.test/soap', envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'secret-missing' } });
  });

  it('answers request.preflight from the project service', async () => {
    const project = {
      scopesFor: vi.fn().mockReturnValue(scopes),
      preflight: vi.fn().mockReturnValue(preflight),
      authFor: vi.fn().mockReturnValue(undefined),
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
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
      },
    });

    expect(await invoke('request.preflight', {})).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });
});

describe('request.send applies the saved request properties', () => {
  beforeEach(() => {
    handlers.clear();
  });

  /** An engine whose `send` records what it was handed and answers with a tiny exchange. */
  function recordingEngine(): { engine: EngineService; sent: RequestSendRequest[] } {
    const engine = new EngineService();
    const sent: RequestSendRequest[] = [];
    vi.spyOn(engine, 'send').mockImplementation((request) => {
      sent.push(request);
      return Promise.resolve({
        sendId: request.sendId,
        durationMs: 1,
        http: {
          status: 200,
          statusText: 'OK',
          headers: {},
          rawHeaders: [],
          bodyBase64: Buffer.from('<ok/>').toString('base64'),
          rawBodyBase64: Buffer.from('<ok/>').toString('base64'),
          rawRequestBase64: '',
          rawResponseBase64: '',
          truncated: false,
          httpVersion: '1.1',
          timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
          redirects: [],
          request: { url: request.input.endpoint, method: 'POST', headers: {} },
        },
        problems: [],
      });
    });
    return { engine, sent };
  }

  it('replaces the renderer input with the property-mapped one', async () => {
    const { engine, sent } = recordingEngine();
    const mapped = {
      endpoint: 'http://mapped.test/soap',
      envelopeXml: '<mapped/>',
      soapVersion: '1.1' as const,
      timeoutMs: 100,
      encoding: 'ISO-8859-1',
    };
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        sendInputFor: () => mapped,
      },
    });

    await invoke('request.send', {
      sendId: 'send-mapped',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    });

    expect(sent[0]?.input).toEqual(mapped);
  });

  it('sends an ad-hoc request exactly as the renderer built it', async () => {
    const { engine, sent } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
      },
    });

    await invoke('request.send', {
      sendId: 'send-adhoc',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    });

    expect(sent[0]?.input.envelopeXml).toBe('<raw/>');
  });

  it("writes the response body to the request's dump file, resolving it against the project dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    const { engine } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        dumpFileFor: () => ({ path: join('dumps', 'last.xml'), projectDir: dir }),
      },
    });

    const result = (await invoke('request.send', {
      sendId: 'send-dump',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    })) as { ok: boolean; value: { problems: { code: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([]);
    expect(readFileSync(join(dir, 'dumps', 'last.xml'), 'utf8')).toBe('<ok/>');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a dump file whose relative path traverses outside the project folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    const { engine } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        dumpFileFor: () => ({ path: join('..', '..', 'escaped.xml'), projectDir: dir }),
      },
    });

    const result = (await invoke('request.send', {
      sendId: 'send-dump-traversal',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    })) as { ok: boolean; value: { problems: { code: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-outside-project' })]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an absolute dump file path outside the project folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-dump-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'wirebench-outside-'));
    const { engine } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        dumpFileFor: () => ({ path: join(outsideDir, 'out.xml'), projectDir: dir }),
      },
    });

    const result = (await invoke('request.send', {
      sendId: 'send-dump-absolute',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    })) as { ok: boolean; value: { problems: { code: string }[] } };

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
    const { engine } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        dumpFileFor: () => ({ path: outsidePath, projectDir: dir }),
      },
      dialogPicks: { hasWrite: (path) => path === outsidePath },
    });

    const result = (await invoke('request.send', {
      sendId: 'send-dump-picked',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    })) as { ok: boolean; value: { problems: { code: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([]);
    expect(readFileSync(outsidePath, 'utf8')).toBe('<ok/>');
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
    const { engine } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        dumpFileFor: () => ({ path: outsidePath, projectDir: dir }),
      },
      // `hasWrite` never returns true for this path: it was only ever offered as a read pick.
      dialogPicks: { hasWrite: () => false },
    });

    const result = (await invoke('request.send', {
      sendId: 'send-dump-read-pick-only',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    })) as { ok: boolean; value: { problems: { code: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-outside-project' })]);
    expect(existsSync(outsidePath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('reports a dump-failed problem instead of failing the send', async () => {
    const { engine } = recordingEngine();
    registerRequestChannels(engine, {
      project: {
        scopesFor: () => scopes,
        preflight: () => preflight,
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => undefined,
        ...noActionSupport,
        // A path whose parent is a file, so `mkdir` cannot create it.
        // The project dir is the filesystem root the temp file lives on, so the containment
        // check passes on every platform ('/' would be the *current drive*'s root on Windows,
        // which need not be the drive holding the temp folder).
        dumpFileFor: () => ({ path: join(existingFile, 'nested', 'out.xml'), projectDir: parse(existingFile).root }),
      },
    });

    const result = (await invoke('request.send', {
      sendId: 'send-dump-fail',
      requestId: 'req-1',
      input: { endpoint: 'http://raw.test/soap', envelopeXml: '<raw/>', soapVersion: '1.1' },
    })) as { ok: boolean; value: { problems: { code: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.problems).toEqual([expect.objectContaining({ code: 'dump-failed' })]);
  });
});
