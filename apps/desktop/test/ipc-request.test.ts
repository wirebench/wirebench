import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyScopes } from '@wirebench/engine';
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

const scopes: PropertyScopes = { project: { stage: 'dev' }, global: {}, env: { who: 'ada' } };

const preflight: PreflightResult = {
  endpoint: 'http://dev.test/soap',
  endpointSource: 'environment',
  unresolved: [{ expr: '${#Env#missing}', code: 'missing', start: 0, end: 15, field: 'envelopeXml' }],
};

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

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
        timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
        redirects: [],
        request: { url: 'http://dev.test/soap', method: 'POST', headers: {} },
      },
      problems: [],
    });
    registerRequestChannels(engine, { project: { scopesFor: () => scopes, preflight: () => preflight } });

    const result = await invoke('request.send', {
      sendId: 'send-1',
      input: { endpoint: 'http://dev.test/soap', envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sendId: 'send-1' }), { scopes });
  });

  it('answers request.preflight from the project service', async () => {
    const project = { scopesFor: vi.fn().mockReturnValue(scopes), preflight: vi.fn().mockReturnValue(preflight) };
    registerRequestChannels(new EngineService(), { project });

    const result = await invoke('request.preflight', { requestId: 'req-1' });

    expect(project.preflight).toHaveBeenCalledWith('req-1');
    expect(result).toEqual({ ok: true, value: preflight });
  });

  it('rejects a malformed request.preflight payload', async () => {
    registerRequestChannels(new EngineService(), {
      project: { scopesFor: () => scopes, preflight: () => preflight },
    });

    expect(await invoke('request.preflight', {})).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });
});
