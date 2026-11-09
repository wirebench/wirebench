import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkspaceSummaryWire } from '@wirebench/wire/wire-base';
import { createAddressSync } from '../../src/renderer/features/address/use-address.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { forgetTabsRestored, notifyTabsRestored } from '../../src/renderer/state/workspace-tabs.js';

const URL_A = 'http://localhost:3000';

function serverRow(id: string, workspaceId: string): WorkspaceSummaryWire {
  return {
    id,
    name: id,
    dir: `/data/${id}`,
    projectCount: 0,
    internalProjectCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    share: { kind: 'server', managed: true, server: { url: URL_A, workspaceId, recording: false } },
  };
}

const W1 = serverRow('w1', 's1');
const W2 = serverRow('w2', 's2');
const opened = (row: WorkspaceSummaryWire) => ({ ...row, projects: [], environments: [] }) as never;

describe('the address sync', () => {
  let sync: ReturnType<typeof createAddressSync>;
  let open: Mock<(id: string) => Promise<void>>;
  let close: Mock<() => Promise<void>>;

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    forgetTabsRestored();
    useEditorsStore.getState().showStart();
    useUiStore.getState().setSidebarView('explorer');
    if (useUiStore.getState().console.visible) useUiStore.getState().collapseConsole();
    open = vi.fn((id: string) => {
      useWorkspaceStore.setState({ workspace: opened(id === 'w1' ? W1 : W2) });
      notifyTabsRestored(id);
      return Promise.resolve();
    });
    close = vi.fn(() => {
      useWorkspaceStore.setState({ workspace: null });
      return Promise.resolve();
    });
    useWorkspaceStore.setState({ workspace: null, workspaces: [W1, W2], ready: true, open, close });
    sync = createAddressSync();
  });
  afterEach(() => {
    sync.stop();
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
    window.history.replaceState(null, '', '/');
  });

  it('opening a workspace is a new entry; a panel only replaces it', async () => {
    await sync.start();
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');

    useWorkspaceStore.setState({ workspace: opened(W1) });
    expect(window.location.pathname).toBe('/workspaces/s1');
    expect(push).toHaveBeenCalledTimes(1);
    notifyTabsRestored('w1');
    await Promise.resolve();

    useUiStore.getState().showConsoleTab('problems');
    expect(window.location.search).toBe('?console=problems');
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalled();

    useUiStore.getState().setSidebarView('history');
    expect(window.location.search).toBe('?view=history&console=problems');
    expect(push).toHaveBeenCalledTimes(2);
    push.mockRestore();
    replace.mockRestore();
  });

  it('a load names the workspace to open, and its view', async () => {
    window.history.replaceState(null, '', '/workspaces/s2?view=history');
    await sync.start();
    expect(open).toHaveBeenCalledWith('w2');
    expect(useUiStore.getState().sidebar.view).toBe('history');
    expect(window.location.pathname).toBe('/workspaces/s2');
    expect(window.location.search).toBe('?view=history');
  });

  it('a load at / keeps the workspace the server reopened, and says so', async () => {
    useWorkspaceStore.setState({ workspace: opened(W1) });
    notifyTabsRestored('w1');
    await sync.start();
    expect(close).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/workspaces/s1');
  });

  it('Back to / leaves the workspace for the list', async () => {
    await sync.start();
    useWorkspaceStore.setState({ workspace: opened(W1) });
    notifyTabsRestored('w1');
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(window.location.pathname).toBe('/');
  });

  it('Settings is a place of its own', async () => {
    await sync.start();
    const push = vi.spyOn(window.history, 'pushState');
    useUiStore.getState().openPreferences();
    expect(window.location.search).toBe('?panel=app');
    expect(push).toHaveBeenCalledTimes(1);
    useUiStore.getState().setPreferencesOpen(false);
    expect(window.location.search).toBe('');
    push.mockRestore();
  });
});
