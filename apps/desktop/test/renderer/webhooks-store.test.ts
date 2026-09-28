import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSeen, SEEN_KEY, writeSeen } from '../../src/renderer/state/webhooks-seen.js';
import { originOf, subscribeToWebhooks, useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import type { CatchUrlWire, WorkspaceWire } from '../../src/shared/wire-types.js';

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const META = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };
const id = (n: number): string => `01J8ZE${String(n).padStart(20, '0')}`;
const hook = (n: number, newest: number | null): CatchUrlWire => ({
  id: `01J8ZC5Q0V7R3T9XK2M4N6H00${n}`,
  workspaceId: WS,
  name: `Hook ${n}`,
  url: `https://wb.test/hooks/${String(n).repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: newest ?? 0,
  newestCaptureId: newest === null ? null : id(newest),
  createdAt: '2026-09-24T12:00:00.000Z',
});
const shared = (workspaceId = WS): WorkspaceWire =>
  workspaceWire({ share: { kind: 'server', managed: true, server: { url: SERVER, workspaceId } } });
const ok = <T>(value: T) => ({ ok: true as const, value });

function api(hooks: readonly CatchUrlWire[], overrides: Partial<WirebenchApi['hooks']> = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const stub = installWirebenchApi({
    hooks: {
      status: vi.fn().mockResolvedValue(ok({ hooks: META })),
      list: vi.fn().mockResolvedValue(ok({ hooks })),
      unseen: vi.fn().mockResolvedValue(ok({ count: 2, more: false })),
      ...overrides,
    },
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
  });
  return { stub, emit: (name: string, payload: unknown): void => listeners.get(name)?.(payload) };
}

describe('the webhooks store (webhook-capture §4.2)', () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    useWorkspaceStore.setState({ workspace: null });
    useWebhooksStore.getState().reset();
  });

  it('asks the server, watches the workspace and lists its catch URLs', async () => {
    const { stub } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    expect(stub.hooks.status).toHaveBeenCalledWith({ url: SERVER });
    expect(stub.hooks.watch).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS });
    expect(useWebhooksStore.getState()).toMatchObject({ meta: META, hooks: [hook(1, null)], error: undefined });
  });

  it('shows nothing for a local workspace or a server without the module', async () => {
    const { stub } = api([], { status: vi.fn().mockResolvedValue(ok({ hooks: null })) });
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    stop = subscribeToWebhooks();
    expect(stub.hooks.status).not.toHaveBeenCalled();

    await useWebhooksStore.getState().follow({ url: SERVER, workspaceId: WS });
    expect(useWebhooksStore.getState().meta).toBeNull();
    expect(stub.hooks.watch).not.toHaveBeenCalled();
    expect(stub.hooks.list).not.toHaveBeenCalled();
  });

  it('marks history as seen on first sight, and counts only what arrived after the marker', async () => {
    writeSeen(SERVER, hook(2, 5).id, id(3));
    const { stub } = api([hook(1, 9), hook(2, 5), hook(3, 4)]);
    writeSeen(SERVER, hook(3, 4).id, id(4));
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() =>
      expect(useWebhooksStore.getState().unseen[hook(2, 5).id]).toEqual({ count: 2, more: false }),
    );

    expect(readSeen(SERVER, hook(1, 9).id)).toBe(id(9)); // first sight
    expect(useWebhooksStore.getState().unseen[hook(3, 4).id]).toEqual({ count: 0, more: false });
    expect(stub.hooks.unseen).toHaveBeenCalledTimes(1);
    expect(stub.hooks.unseen).toHaveBeenCalledWith({
      url: SERVER,
      workspaceId: WS,
      hookId: hook(2, 5).id,
      after: id(3),
    });
    expect(localStorage.getItem(SEEN_KEY)).toContain(hook(1, 9).id);
  });

  it('counts from the first capture for a catch URL seen empty', async () => {
    const { stub } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    expect(readSeen(SERVER, hook(1, null).id)).toBe('');

    await useWebhooksStore.getState().recount(hook(1, null).id);
    expect(stub.hooks.unseen).toHaveBeenCalledWith({
      url: SERVER,
      workspaceId: WS,
      hookId: hook(1, null).id,
      after: null,
    });
  });

  it('recounts on hooks.captured, re-lists on hooks.changed, and ignores another workspace', async () => {
    const { stub, emit } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));

    emit('hooks.captured', { url: SERVER, workspaceId: WS, hookId: hook(1, null).id, captureId: id(1) });
    await vi.waitFor(() => expect(useWebhooksStore.getState().unseen[hook(1, null).id]?.count).toBe(2));
    emit('hooks.changed', { url: SERVER, workspaceId: WS });
    await vi.waitFor(() => expect(stub.hooks.list).toHaveBeenCalledTimes(2));
    emit('hooks.changed', { url: SERVER, workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB' });
    emit('hooks.captured', { url: 'https://other.test', workspaceId: WS, hookId: hook(1, null).id, captureId: id(2) });
    expect(stub.hooks.list).toHaveBeenCalledTimes(2);
    expect(stub.hooks.unseen).toHaveBeenCalledTimes(1);
  });

  it('marking seen zeroes the badge and moves the marker', async () => {
    api([hook(1, 3)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    useWebhooksStore.setState({ unseen: { [hook(1, 3).id]: { count: 4, more: false } } });
    useWebhooksStore.getState().markSeen(hook(1, 3).id, id(7));
    expect(useWebhooksStore.getState().unseen[hook(1, 3).id]).toEqual({ count: 0, more: false });
    expect(readSeen(SERVER, hook(1, 3).id)).toBe(id(7));
  });

  it('keys seen markers by server origin, so a URL spelling change finds the same marker', () => {
    writeSeen(originOf('https://s.test/'), hook(1, 3).id, id(7));
    expect(readSeen(originOf('https://s.test'), hook(1, 3).id)).toBe(id(7));
  });

  it('drops a recount answer if the open tab marked captures seen before it resolved', async () => {
    let resolveUnseen!: (value: { ok: true; value: { count: number; more: boolean } }) => void;
    const unseen = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveUnseen = resolve;
        }),
    );
    api([hook(1, 3)], { unseen: unseen as never });
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));

    const recounting = useWebhooksStore.getState().recount(hook(1, 3).id);
    useWebhooksStore.getState().markSeen(hook(1, 3).id, id(9));
    resolveUnseen(ok({ count: 5, more: false }));
    await recounting;

    expect(useWebhooksStore.getState().unseen[hook(1, 3).id]).toEqual({ count: 0, more: false });
  });

  it('unwatches and resets when the workspace switches', async () => {
    const { stub, emit } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    emit('workspace.changed', { workspace: workspaceWire({ id: 'w2' }) });
    await vi.waitFor(() => expect(stub.hooks.unwatch).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS }));
    expect(useWebhooksStore.getState()).toMatchObject({ server: undefined, hooks: [], loaded: false });
  });

  it('asks again after a failed status once the live socket connects', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'server-unreachable', message: 'Could not reach https://wb.test' },
      })
      .mockResolvedValue(ok({ hooks: META }));
    const { stub } = api([hook(1, null)], { status });
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(useWebhooksStore.getState().meta).toBeUndefined();

    useSyncStore.setState({ status: { ...useSyncStore.getState().status, live: 'connected' } });
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    expect(stub.hooks.watch).toHaveBeenCalledTimes(1);
    useSyncStore.getState().reset();
  });
});
