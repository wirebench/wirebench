// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSshChannels } from '../src/main/areas/ssh.js';

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
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: {} }, payload);
}

const EMPTY = { file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] };

beforeEach(() => {
  handlers.clear();
});

describe('ssh channels', () => {
  it('ssh.listHosts answers the service; ssh.saveHosts passes the file through', async () => {
    const list = vi.fn().mockResolvedValue(EMPTY);
    const save = vi.fn().mockResolvedValue(EMPTY);
    registerSshChannels({ hosts: { list, save }, ssh: {} });
    expect(await invoke('ssh.listHosts', undefined)).toEqual({ ok: true, value: EMPTY });
    await invoke('ssh.saveHosts', { file: EMPTY.file });
    expect(save).toHaveBeenCalledWith(EMPTY.file);
  });
});
