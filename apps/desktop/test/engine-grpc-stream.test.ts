// @vitest-environment node
/**
 * The interactive gRPC calls the `request.*` channels drive through the exchange registry, beside
 * every other send in flight.
 *
 * A push or a half-close names a call by the same `sendId` its send used, which means both can
 * arrive for a call that has already ended — the user hit Send again, the deadline passed, the
 * server hung up. Neither may reach a dead stream, so this is what each answers instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { ExchangeRegistry } from '../src/main/send/exchange.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, payload);
}

function register(): void {
  handlers.clear();
  const model = createProject('Demo', { id: 'p1' });
  registerRequestChannels(new EngineService(), {
    project: {
      projectId: () => model.id,
      runContextFor: () => ({ project: model, projectDir: '/tmp/none' }),
    } as unknown as RequestChannelDeps['project'],
  });
}

describe('an interactive gRPC call that is not open', () => {
  it('refuses a push naming a call that is not open', async () => {
    register();

    const reply = (await invoke('request.grpcPush', { sendId: 'never-opened', messageText: '{}' })) as {
      ok: boolean;
      error?: { code: string };
    };
    // The handler throws a WirebenchError; the channel answers with its code.
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('grpc-stream-unknown');
  });

  it('answers a half-close for a call that is not open rather than throwing', async () => {
    register();

    expect(await invoke('request.grpcHalfClose', { sendId: 'never-opened' })).toEqual({
      ok: true,
      value: { closed: false },
    });
    expect(new ExchangeRegistry().halfClose('never-opened')).toBe(false);
  });
});
