import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { validateEventPayload, wrapHandler } from '../src/main/ipc/envelope.js';
import { emitEvent } from '../src/main/ipc/events.js';
import { channels, defineEvent } from '../src/shared/ipc.js';

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

  it('maps a thrown handler result that fails the response schema to ipc-invalid-response', async () => {
    const wrapped = wrapHandler(channels.app.version, () =>
      // Deliberately wrong shape to exercise response-schema validation.
      Promise.resolve({ version: 0.1 } as unknown as { version: string; electron: string; node: string }),
    );

    const result = await wrapped(undefined);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ipc-invalid-response',
        message: 'Handler returned a value that does not match the response schema',
      },
    });
    if (!result.ok) {
      expect(result.error.details?.['issues']).toBeInstanceOf(Array);
    }
  });
});

describe('validateEventPayload', () => {
  const testEvent = defineEvent('test.event', z.object({ at: z.string() }));

  it('returns the parsed payload for a valid payload', () => {
    const parsed = validateEventPayload(testEvent, { at: '2026-01-01T00:00:00.000Z' });
    expect(parsed).toEqual({ at: '2026-01-01T00:00:00.000Z' });
  });

  it('throws a WirebenchError for an invalid payload', () => {
    expect(() => validateEventPayload(testEvent, { at: 123 })).toThrowError(WirebenchError);
    try {
      validateEventPayload(testEvent, { at: 123 });
      throw new Error('expected validateEventPayload to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WirebenchError);
      expect((err as WirebenchError).code).toBe('ipc-invalid-event');
    }
  });
});

describe('emitEvent', () => {
  const testEvent = defineEvent('test.event', z.object({ message: z.string() }));

  it('does not call send when the target WebContents is destroyed', () => {
    const sendMock = vi.fn();
    const target: Partial<WebContents> = {
      isDestroyed: () => true,
      send: sendMock,
    };

    emitEvent(target as unknown as WebContents, testEvent, { message: 'hello' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('calls send with the event name and validated payload when the target is not destroyed', () => {
    const sendMock = vi.fn();
    const target: Partial<WebContents> = {
      isDestroyed: () => false,
      send: sendMock,
    };

    emitEvent(target as unknown as WebContents, testEvent, { message: 'hello' });

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith('test.event', { message: 'hello' });
  });

  it('throws on invalid payload even when the target is destroyed (validates first)', () => {
    const sendMock = vi.fn();
    const target: Partial<WebContents> = {
      isDestroyed: () => true,
      send: sendMock,
    };

    const invalidPayload = { message: 123 };
    expect(() =>
      emitEvent(target as unknown as WebContents, testEvent, invalidPayload as unknown as { message: string }),
    ).toThrowError(WirebenchError);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
