// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerHooksChannels } = await import('../src/main/ipc/hooks.js');
const { channels } = await import('../src/shared/ipc.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const REF = { url: SERVER, workspaceId: WS, hookId: HOOK_ID };
const HOOK = {
  id: HOOK_ID,
  workspaceId: WS,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};

function fakeService() {
  return {
    status: vi.fn().mockResolvedValue({ enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 }),
    list: vi.fn().mockResolvedValue([HOOK]),
    create: vi.fn().mockResolvedValue(HOOK),
    update: vi.fn().mockResolvedValue(HOOK),
    rotate: vi.fn().mockResolvedValue(HOOK),
    remove: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    unseen: vi.fn().mockResolvedValue({ count: 3, more: false }),
    watch: vi.fn(),
    unwatch: vi.fn(),
    open: vi.fn().mockResolvedValue({ viewId: 'view-1', captures: [], more: false }),
    older: vi.fn().mockResolvedValue({ captures: [], more: false }),
    capture: vi.fn().mockRejectedValue(new WirebenchError('hooks-view-closed', 'This catch URL tab is closed.')),
    close: vi.fn(),
  };
}

describe('hooks.* channels (webhook-capture §4.1)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers every channel the contract declares', () => {
    registerHooksChannels({ hooks: fakeService() });
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(channels.hooks)
        .map((c) => c.name)
        .sort(),
    );
  });

  it('passes each request to the service and answers in wire shapes', async () => {
    const hooks = fakeService();
    registerHooksChannels({ hooks });
    expect(await invoke('hooks.status', { url: SERVER })).toEqual({
      ok: true,
      value: { hooks: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 } },
    });
    expect(await invoke('hooks.list', { url: SERVER, workspaceId: WS })).toEqual({
      ok: true,
      value: { hooks: [HOOK] },
    });
    expect(
      await invoke('hooks.create', { url: SERVER, workspaceId: WS, name: 'Payments', response: { status: 202 } }),
    ).toEqual({ ok: true, value: { hook: HOOK } });
    expect(hooks.create).toHaveBeenCalledWith(SERVER, WS, { name: 'Payments', response: { status: 202 } });
    await invoke('hooks.update', { ...REF, enabled: false });
    expect(hooks.update).toHaveBeenCalledWith(REF, { enabled: false });
    expect(await invoke('hooks.rotate', REF)).toEqual({ ok: true, value: { hook: HOOK } });
    expect(await invoke('hooks.clear', REF)).toEqual({ ok: true, value: { done: true } });
    expect(await invoke('hooks.remove', REF)).toEqual({ ok: true, value: { done: true } });
    expect(await invoke('hooks.unseen', { ...REF, after: null })).toEqual({
      ok: true,
      value: { count: 3, more: false },
    });
    expect(hooks.unseen).toHaveBeenCalledWith(REF, null);
    expect(await invoke('hooks.watch', { url: SERVER, workspaceId: WS })).toEqual({ ok: true, value: { done: true } });
    expect(hooks.watch).toHaveBeenCalledWith(SERVER, WS);
    await invoke('hooks.unwatch', { url: SERVER, workspaceId: WS });
    expect(hooks.unwatch).toHaveBeenCalledWith(SERVER, WS);
    expect(await invoke('hooks.open', REF)).toEqual({
      ok: true,
      value: { viewId: 'view-1', captures: [], more: false },
    });
    expect(await invoke('hooks.older', { viewId: 'view-1' })).toEqual({
      ok: true,
      value: { captures: [], more: false },
    });
    expect(await invoke('hooks.close', { viewId: 'view-1' })).toEqual({ ok: true, value: { done: true } });
    expect(hooks.close).toHaveBeenCalledWith('view-1');
  });

  it('passes a service error through as the envelope error', async () => {
    registerHooksChannels({ hooks: fakeService() });
    expect(await invoke('hooks.capture', { viewId: 'view-1', captureId: '01J8ZE00000000000000000001' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'hooks-view-closed' }) as unknown,
    });
  });
});
