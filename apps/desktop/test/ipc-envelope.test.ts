import { WirebenchError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { wrapHandler } from '../src/main/ipc/envelope.js';
import { channels } from '../src/shared/ipc.js';

describe('wrapHandler', () => {
  it('rejects a malformed request payload before calling the handler', async () => {
    let called = false;
    const wrapped = wrapHandler(channels.app.version, () => {
      called = true;
      return Promise.resolve({ version: '0.1.0', electron: '44.0.0', node: '24.0.0' });
    });

    const result = await wrapped({ bogus: 1 });

    expect(called).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'ipc-invalid-request' }) as unknown,
    });
  });

  it('maps a thrown WirebenchError to its own code', async () => {
    const wrapped = wrapHandler(channels.app.version, () => {
      throw new WirebenchError('app.version.boom', 'boom');
    });

    const result = await wrapped(undefined);

    expect(result).toEqual({ ok: false, error: { code: 'app.version.boom', message: 'boom' } });
  });

  it('maps a thrown plain Error to internal-error', async () => {
    const wrapped = wrapHandler(channels.app.version, () => {
      throw new Error('unexpected');
    });

    const result = await wrapped(undefined);

    expect(result).toEqual({ ok: false, error: { code: 'internal-error', message: 'unexpected' } });
  });

  it('returns a validated success value for a valid call', async () => {
    const wrapped = wrapHandler(channels.app.version, () =>
      Promise.resolve({ version: '0.1.0', electron: '44.0.0', node: '24.0.0' }),
    );

    const result = await wrapped(undefined);

    expect(result).toEqual({
      ok: true,
      value: { version: '0.1.0', electron: '44.0.0', node: '24.0.0' },
    });
  });
});
