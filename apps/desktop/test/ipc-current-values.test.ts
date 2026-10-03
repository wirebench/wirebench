// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentValuesStore } from '../src/main/current-values.js';
import { registerCurrentValuesChannels } from '../src/main/ipc/current-values.js';
import { channels } from '../src/shared/ipc.js';
import type { WorkspaceWire } from '../src/shared/wire-types.js';

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      registeredHandlers.set(name, handler);
    },
  },
}));

function invoke(
  channelName: string,
  payload?: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> {
  const handler = registeredHandlers.get(channelName);
  if (handler === undefined) {
    throw new Error(`${channelName} was never registered`);
  }
  return handler({ sender: {} }, payload) as Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;
}

const WORKSPACE = { scope: 'workspace' } as const;

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerCurrentValuesChannels', () => {
  it('answers every channel with the whole state', async () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace({
      id: 'w1',
      properties: { host: 'a.test', port: '80' },
      environments: [],
    } as unknown as WorkspaceWire);
    registerCurrentValuesChannels(store);

    expect(await invoke(channels.currentValues.get.name, undefined)).toEqual({ ok: true, value: { scopes: [] } });
    await invoke(channels.currentValues.set.name, { key: WORKSPACE, name: 'host', value: 'mine.test' });
    expect(await invoke(channels.currentValues.set.name, { key: WORKSPACE, name: 'port', value: '8080' })).toEqual({
      ok: true,
      value: { scopes: [{ key: WORKSPACE, values: { host: 'mine.test', port: '8080' } }] },
    });
    expect(await invoke(channels.currentValues.reset.name, { key: WORKSPACE, name: 'host' })).toEqual({
      ok: true,
      value: { scopes: [{ key: WORKSPACE, values: { port: '8080' } }] },
    });
    expect(await invoke(channels.currentValues.reset.name, { key: WORKSPACE })).toEqual({
      ok: true,
      value: { scopes: [] },
    });
  });

  it('refuses a current value for a variable with no committed value', async () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace({ id: 'w1', properties: {}, environments: [] } as unknown as WorkspaceWire);
    registerCurrentValuesChannels(store);
    const result = await invoke(channels.currentValues.set.name, { key: WORKSPACE, name: 'ghost', value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('current-value-unknown');
  });
});
