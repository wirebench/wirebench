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
  '../src/main/kinds/kind-main.js',
  '../src/main/window-scope.js',
  '../src/main/workspace-service.js',
  '../src/main/send/exchange.js',
  '../src/main/project-mutations.js',
  '../src/main/project-host.js',
  '../src/main/ipc/log.js',
  '../src/main/ipc/search.js',
  '../src/main/kinds/rest/ipc.js',
  '../src/main/kinds/soap/ipc.js',
  '../src/main/kinds/mcp/ipc.js',
];

describe('loading main with the kinds in a cycle', () => {
  it.each(ENTRIES)('loads %s first and still sees every kind', async (entry) => {
    vi.resetModules();
    await import(entry);
    const { MAIN_KINDS } = await import('../src/main/kinds/kind-main.js');
    expect(MAIN_KINDS.map((kind) => kind.kind)).toEqual(['soap', 'rest', 'grpc', 'websocket', 'mcp']);
  });
});
