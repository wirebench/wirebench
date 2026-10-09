import { beforeEach, expect, it } from 'vitest';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { saveWorkspaceTabs } from '../../src/renderer/state/workspace-tabs.js';

beforeEach(() => {
  useEditorsStore.getState().reset();
  useUiStore.setState({ workspaces: {}, sidebar: DEFAULT_UI_STATE.sidebar });
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    sessions: {},
  });
});

it('an ssh-terminal tab is not persisted', () => {
  const editors = useEditorsStore.getState();
  editors.open({ id: 'ssh:a', kind: 'ssh-terminal', title: 'a', hostId: 'a' });
  editors.open({ id: 'request:r1', kind: 'request', title: 'r', requestId: 'r1' });
  saveWorkspaceTabs('w1');
  expect(useUiStore.getState().workspaces['w1']?.tabs).toEqual([{ kind: 'request', id: 'r1' }]);
});

it('openTerminalFor opens one tab per host, titled with the host name, and reactivates it', () => {
  openTerminalFor('a');
  useEditorsStore.getState().showStart();
  openTerminalFor('a');
  const { tabs, activeId } = useEditorsStore.getState();
  expect(tabs).toEqual([{ id: 'ssh:a', kind: 'ssh-terminal', title: 'alpha', hostId: 'a' }]);
  expect(activeId).toBe('ssh:a');
});

it('closing the workspace drops terminal tabs with the rest', () => {
  openTerminalFor('a');
  useEditorsStore.getState().reset();
  expect(useEditorsStore.getState().tabs).toEqual([]);
});
