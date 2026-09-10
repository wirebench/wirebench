import { describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
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
