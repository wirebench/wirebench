import { WirebenchError } from '@wirebench/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSecretSourcesChannels } from '../src/main/ipc/secret-sources.js';
import type { SecretSourcesState } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const STATE: SecretSourcesState = {
  open: true,
  entries: [{ name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'f' }, overridden: false }],
  hash: 'ab'.repeat(32),
  trusted: false,
  changes: [{ name: 'db', change: 'added' }],
};

function fakes() {
  const workspace = {
    secretSourcesState: vi.fn(() => STATE),
    setSharedSecretSources: vi.fn(() => Promise.resolve({ ok: true, issues: [] })),
    setLocalSecretSources: vi.fn(() => Promise.resolve({ ok: true, issues: [] })),
    approveSecretSources: vi.fn((): Promise<SecretSourcesState> => Promise.resolve({ ...STATE, trusted: true })),
  };
  const sources = {
    test: vi.fn(() => Promise.resolve({ ok: true as const, length: 2 })),
    clear: vi.fn(),
    noteChange: vi.fn(),
  };
  registerSecretSourcesChannels(workspace, sources);
  return { workspace, sources };
}

beforeEach(() => {
  handlers.clear();
});

describe('registerSecretSourcesChannels', () => {
  it('get answers the workspace state', async () => {
    fakes();
    expect(await invoke('secretSources.get')).toEqual({ ok: true, value: STATE });
  });

  it('test answers a length and never the value', async () => {
    const { sources } = fakes();
    sources.test.mockImplementation(() => {
      // The value itself stays inside the service; only its length crosses.
      const value = 'pw';
      return Promise.resolve({ ok: true as const, length: value.length });
    });
    const reply = await invoke('secretSources.test', { name: 'db' });
    expect(reply).toEqual({ ok: true, value: { ok: true, length: 2 } });
    expect(JSON.stringify(reply)).not.toContain('pw');
    expect(sources.test).toHaveBeenCalledWith('db');
  });

  it('setShared forwards one entry, then notes the change', async () => {
    const { workspace, sources } = fakes();
    const request = { name: 'db', previousName: 'old', entry: { kind: 'vault', path: 'kv/app', field: 'f' } };
    expect(await invoke('secretSources.setShared', request)).toEqual({ ok: true, value: { ok: true, issues: [] } });
    expect(workspace.setSharedSecretSources).toHaveBeenCalledWith(request);
    expect(sources.noteChange).toHaveBeenCalledTimes(1);
    expect(workspace.setSharedSecretSources.mock.invocationCallOrder[0]).toBeLessThan(
      sources.noteChange.mock.invocationCallOrder[0] as number,
    );
  });

  it('setLocal forwards a removal, then notes the change', async () => {
    const { workspace, sources } = fakes();
    await invoke('secretSources.setLocal', { name: 'db', entry: null });
    expect(workspace.setLocalSecretSources).toHaveBeenCalledWith({ name: 'db', entry: null });
    expect(sources.noteChange).toHaveBeenCalledTimes(1);
  });

  it('refuses an entry whose fields are not strings', async () => {
    const { workspace } = fakes();
    const reply = (await invoke('secretSources.setShared', { name: 'db', entry: { kind: 'vault', path: 1 } })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(reply).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
    expect(workspace.setSharedSecretSources).not.toHaveBeenCalled();
  });

  it('approve answers a stale hash with an error envelope', async () => {
    const { workspace, sources } = fakes();
    workspace.approveSecretSources.mockRejectedValue(
      new WirebenchError('secret-source-approval-stale', 'The shared secret sources changed.'),
    );
    expect(await invoke('secretSources.approve', { hash: 'cd'.repeat(32) })).toMatchObject({
      ok: false,
      error: { code: 'secret-source-approval-stale' },
    });
    expect(sources.noteChange).not.toHaveBeenCalled();
  });

  it('approve answers the new state and notes the change', async () => {
    const { workspace, sources } = fakes();
    expect(await invoke('secretSources.approve', { hash: STATE.hash })).toMatchObject({
      ok: true,
      value: { trusted: true },
    });
    expect(workspace.approveSecretSources).toHaveBeenCalledWith(STATE.hash);
    expect(sources.noteChange).toHaveBeenCalledTimes(1);
  });

  it('clearCache clears the source cache', async () => {
    const { sources } = fakes();
    expect(await invoke('secretSources.clearCache')).toEqual({ ok: true, value: undefined });
    expect(sources.clear).toHaveBeenCalledTimes(1);
  });
});
