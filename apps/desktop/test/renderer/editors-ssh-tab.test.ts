import { beforeEach, expect, it } from 'vitest';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { openFiles } from '../../src/renderer/features/ssh/files/open-files.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { tabSetOf } from '../../src/renderer/state/tab-sets.js';
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

it('an ssh-files tab is not persisted and joins the SSH tab set', () => {
  const editors = useEditorsStore.getState();
  openFiles('a');
  editors.open({ id: 'request:r1', kind: 'request', title: 'r', requestId: 'r1' });
  saveWorkspaceTabs('w1');
  expect(useUiStore.getState().workspaces['w1']?.tabs).toEqual([{ kind: 'request', id: 'r1' }]);
  expect(tabSetOf({ kind: 'ssh-files' })).toBe('ssh');
});

it('openFiles opens one Files tab per host, titled "<host> · Files", and focuses it again', () => {
  openFiles('a');
  useEditorsStore.getState().showStart();
  openFiles('a');
  const { tabs, activeId } = useEditorsStore.getState();
  expect(tabs).toEqual([{ id: 'ssh-files:a', kind: 'ssh-files', title: 'alpha · Files', hostId: 'a' }]);
  expect(activeId).toBe('ssh-files:a');
});

it('closing the workspace drops terminal tabs with the rest', () => {
  openTerminalFor('a');
  useEditorsStore.getState().reset();
  expect(useEditorsStore.getState().tabs).toEqual([]);
});
