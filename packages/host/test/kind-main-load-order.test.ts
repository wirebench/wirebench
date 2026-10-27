// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
  app: { getPath: () => '' },
}));

/**
 * The kinds import modules that import `kinds/kind-main.ts` back (a kind's IPC registers through
 * `ipc/register.ts`, its send path calls `send/exchange.ts`), so a module that read `MAIN_KINDS` while
 * modules were still loading would fail whenever it happened to load before the registry.
 */
const ENTRIES = [
  '../src/kinds/kind-main.js',
  '../src/window-scope.js',
  '../src/workspace-service.js',
  '../src/send/exchange.js',
  '../src/project-mutations.js',
  '../src/project-host.js',
  '../src/ipc/log.js',
  '../src/ipc/search.js',
  '../src/kinds/rest/ipc.js',
  '../src/kinds/soap/ipc.js',
  '../src/kinds/mcp/ipc.js',
];

describe('loading main with the kinds in a cycle', () => {
  it.each(ENTRIES)('loads %s first and still sees every kind', async (entry) => {
    vi.resetModules();
    await import(entry);
    const { MAIN_KINDS } = await import('../src/kinds/kind-main.js');
    expect(MAIN_KINDS.map((kind) => kind.kind)).toEqual(['soap', 'rest', 'grpc', 'websocket', 'mcp']);
  });
});
