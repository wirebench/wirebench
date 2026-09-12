import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_STATE,
  UI_STORAGE_KEY,
  UI_STORAGE_VERSION,
  readUi,
  writeUi,
} from '../../src/renderer/state/ui-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import {
  rememberOpenWorkspaceTabs,
  restoreWorkspaceTabs,
  saveWorkspaceTabs,
} from '../../src/renderer/state/workspace-tabs.js';
import { environmentTabId } from '../../src/renderer/features/environments/environment-actions.js';
import { interfaceTabId } from '../../src/renderer/features/interface-editor/interface-actions.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

/** A `Storage` that only ever lives in the test — no jsdom global to reset between cases. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('per-workspace UI state', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useProjectStore.getState().reset();
    useUiStore.setState({ workspaces: {}, sidebar: DEFAULT_UI_STATE.sidebar });
    useWorkspaceStore.setState({ workspace: null });
  });

  it('round-trips the per-workspace tabs through storage', () => {
    const storage = memoryStorage();
    writeUi(
      {
        ...DEFAULT_UI_STATE,
        workspaces: {
          w1: { tabs: [{ kind: 'request', id: 'r1' }], activeId: 'r1', sidebarView: 'history' },
        },
      },
      storage,
    );

    expect(readUi(storage).workspaces).toEqual({
      w1: { tabs: [{ kind: 'request', id: 'r1' }], activeId: 'r1', sidebarView: 'history' },
    });
  });

  it('drops a payload written by an older version', () => {
    const storage = memoryStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ version: UI_STORAGE_VERSION - 1, state: { workspaces: { w1: { tabs: [] } } } }),
    );

    expect(readUi(storage).workspaces).toEqual({});
  });

  it('keeps the sound entries of a half-corrupt map', () => {
    const storage = memoryStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: UI_STORAGE_VERSION,
        state: {
          workspaces: {
            w1: { tabs: [{ kind: 'request', id: 'r1' }, { kind: 'diff', id: 'd1' }, 7], sidebarView: 'nonsense' },
            w2: 'not an object',
          },
        },
      }),
    );

    expect(readUi(storage).workspaces).toEqual({ w1: { tabs: [{ kind: 'request', id: 'r1' }] } });
  });

  it('saves the three durable tab kinds and drops the rest', () => {
    const editors = useEditorsStore.getState();
    editors.open({ id: 'request:r1', kind: 'request', title: 'Add', requestId: 'r1' });
    editors.open({ id: interfaceTabId('i1'), kind: 'interface', title: 'Calculator', interfaceId: 'i1' });
    editors.open({ id: environmentTabId('e1'), kind: 'environment', title: 'Dev', environmentId: 'e1' });
    editors.open({ id: 'history:h1', kind: 'history', title: 'Sent', historyId: 'h1' });
    editors.open({ id: 'preferences', kind: 'preferences', title: 'Preferences' });

    saveWorkspaceTabs('w1');

    expect(useUiStore.getState().workspaces['w1']).toEqual({
      tabs: [
        { kind: 'request', id: 'r1' },
        { kind: 'interface', id: 'i1' },
        { kind: 'environment', id: 'e1' },
      ],
      sidebarView: 'explorer',
    });
  });

  it('reopens the tabs whose entities still resolve, and only those', () => {
    useUiStore.getState().setWorkspaceUi('w1', {
      tabs: [
        { kind: 'request', id: 'r1' },
        { kind: 'request', id: 'gone' },
        { kind: 'interface', id: 'i1' },
        { kind: 'environment', id: 'we1' },
      ],
      activeId: 'i1',
      sidebarView: 'wss',
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [{ id: 'we1', name: 'Dev', slug: 'dev', order: 0, properties: {}, endpoints: {}, disabled: [] }],
      }),
    });
    useProjectStore.setState({
      requests: { r1: { id: 'r1', name: 'Add' } },
      interfaces: { i1: { id: 'i1', name: 'Calculator' } },
    } as never);

    restoreWorkspaceTabs('w1');

    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs.map((tab) => tab.id)).toEqual(['request:r1', interfaceTabId('i1'), environmentTabId('we1')]);
    expect(tabs.map((tab) => tab.title)).toEqual(['Add', 'Calculator', 'Dev']);
    expect(activeId).toBe(interfaceTabId('i1'));
    expect(useUiStore.getState().sidebar.view).toBe('wss');
  });

  it('shows the Start tab when the remembered active tab is gone', () => {
    useUiStore.getState().setWorkspaceUi('w1', { tabs: [{ kind: 'request', id: 'gone' }], activeId: 'gone' });

    restoreWorkspaceTabs('w1');

    expect(useEditorsStore.getState().tabs).toEqual([]);
    expect(useEditorsStore.getState().activeId).toBeUndefined();
  });

  it('records the open workspace on the way out, and nothing at all with none open', () => {
    useEditorsStore.getState().open({ id: 'request:r1', kind: 'request', title: 'Add', requestId: 'r1' });

    // No workspace open: quitting from the picker must not invent an entry.
    rememberOpenWorkspaceTabs();
    expect(useUiStore.getState().workspaces).toEqual({});

    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'w1' }) });
    rememberOpenWorkspaceTabs();
    expect(useUiStore.getState().workspaces['w1']?.tabs).toEqual([{ kind: 'request', id: 'r1' }]);
  });
});
