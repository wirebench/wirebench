// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProjectChannels } from '../src/main/ipc/project.js';
import type { ProjectChannelDeps } from '../src/main/ipc/project.js';

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
  return handler({ sender: {} }, payload);
}

describe('project.addInterface', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('forwards auth and useForRequests to the project service', async () => {
    // `useForRequests` is what persists `Interface.auth`; dropping it here silently produced an
    // interface whose requests then went out unauthenticated.
    const addInterface = vi.fn().mockResolvedValue({ project: null, interfaceId: 'iface-1' });
    registerProjectChannels({
      router: { addInterface } as unknown as ProjectChannelDeps['router'],
      addProject: vi.fn(),
    });

    await invoke('project.addInterface', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1' },
      useForRequests: true,
    });

    expect(addInterface).toHaveBeenCalledWith('p1', {
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1' },
      useForRequests: true,
    });
  });
});
