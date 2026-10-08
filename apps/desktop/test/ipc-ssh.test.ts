// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostsService } from '../src/main/hosts-service.js';
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
  it('a refused save answers its own code, not internal-error, and never echoes the bad name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-ipc-ssh-'));
    registerSshChannels({ hosts: new HostsService({ treeDir: () => dir }), ssh: {} });
    const host = {
      id: 'a',
      name: 'A',
      address: 'x',
      tags: [],
      ssh: { auth: { kind: 'password', secret: 'hunter two' } },
    };
    const answer = (await invoke('ssh.saveHosts', { file: { version: 1, groups: [], hosts: [host] } })) as {
      ok: boolean;
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(answer.ok).toBe(false);
    expect(answer.error.code).toBe('ssh-literal-secret');
    expect(JSON.stringify(answer)).not.toContain('hunter');
  });
  it('a stray key in the request is an invalid request', async () => {
    registerSshChannels({ hosts: { list: vi.fn(), save: vi.fn() }, ssh: {} });
    const answer = (await invoke('ssh.saveHosts', { file: { ...EMPTY.file, extra: 1 } })) as { ok: boolean };
    expect(answer.ok).toBe(false);
  });
  it('ssh.listHosts answers the service; ssh.saveHosts passes the file through', async () => {
    const list = vi.fn().mockResolvedValue(EMPTY);
    const save = vi.fn().mockResolvedValue(EMPTY);
    registerSshChannels({ hosts: { list, save }, ssh: {} });
    expect(await invoke('ssh.listHosts', undefined)).toEqual({ ok: true, value: EMPTY });
    await invoke('ssh.saveHosts', { file: EMPTY.file });
    expect(save).toHaveBeenCalledWith(EMPTY.file);
  });
});
