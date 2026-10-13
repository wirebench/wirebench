import { beforeEach, expect, it } from 'vitest';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { openFiles } from '../../src/renderer/features/ssh/files/open-files.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { leaves, onePane, split } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { tabSetOf } from '../../src/renderer/state/tab-sets.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { saveWorkspaceTabs } from '../../src/renderer/state/workspace-tabs.js';

beforeEach(() => {
  useEditorsStore.getState().reset();
  useUiStore.setState({ workspaces: {}, sidebar: DEFAULT_UI_STATE.sidebar });
  useHostsStore.setState({
    file: {
      version: 1,
      groups: [],
      hosts: [
        { id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} },
        { id: 'b', name: 'beta', address: 'b.example', tags: [], ssh: {} },
      ],
    },
    panes: {},
    terminalTabUse: {},
    reconnectNonce: {},
    trustPrompt: null,
  });
});

it('an ssh-terminal tab is not persisted', () => {
  const editors = useEditorsStore.getState();
  editors.open({ id: 'ssh-terminal:t1', kind: 'ssh-terminal', title: 'a', panes: onePane('a') });
  editors.open({ id: 'request:r1', kind: 'request', title: 'r', requestId: 'r1' });
  saveWorkspaceTabs('w1');
  expect(useUiStore.getState().workspaces['w1']?.tabs).toEqual([{ kind: 'request', id: 'r1' }]);
});

it('openTerminalFor opens one tab per host, titled with the host name, and reactivates it', () => {
  openTerminalFor('a');
  useEditorsStore.getState().showStart();
  openTerminalFor('a');
  const { tabs, activeId } = useEditorsStore.getState();
  expect(tabs).toEqual([
    {
      id: expect.stringMatching(/^ssh-terminal:[0-9a-f-]{36}$/) as unknown,
      kind: 'ssh-terminal',
      title: 'alpha',
      panes: { kind: 'pane', paneId: expect.any(String) as unknown, hostId: 'a' },
    },
  ]);
  expect(activeId).toBe(tabs[0]?.id);
});

it('connecting a host focuses the tab used most recently with a pane on it', () => {
  const editors = useEditorsStore.getState();
  const hosts = useHostsStore.getState();
  editors.open({ id: 'ssh-terminal:t1', kind: 'ssh-terminal', title: 'a', panes: onePane('a') });
  hosts.noteTerminalTabUsed('ssh-terminal:t1');
  // A second tab with a pane on the same host and one on another.
  const first = onePane('b');
  const two = split(first, leaves(first)[0]?.paneId ?? '', 'row', 'a');
  editors.open({ id: 'ssh-terminal:t2', kind: 'ssh-terminal', title: 'b', panes: two });
  useHostsStore.getState().noteTerminalTabUsed('ssh-terminal:t2');
  editors.activate('ssh-terminal:t1');
  useHostsStore.getState().noteTerminalTabUsed('ssh-terminal:t1');
  useEditorsStore.getState().showStart();

  openTerminalFor('a');
  expect(useEditorsStore.getState().activeId).toBe('ssh-terminal:t1');
  expect(useEditorsStore.getState().tabs).toHaveLength(2);
  useHostsStore.getState().noteTerminalTabUsed('ssh-terminal:t2');
  openTerminalFor('a');
  expect(useEditorsStore.getState().activeId).toBe('ssh-terminal:t2');
  openTerminalFor('b');
  expect(useEditorsStore.getState().activeId).toBe('ssh-terminal:t2');
});

it('connecting a host again retries only its settled panes in that tab', () => {
  openTerminalFor('a');
  const tab = useEditorsStore.getState().tabs[0];
  const paneId = tab?.panes === undefined ? '' : (leaves(tab.panes)[0]?.paneId ?? '');
  useHostsStore.getState().setPane(paneId, { hostId: 'a', sessionId: 's1', state: 'open' });
  openTerminalFor('a');
  expect(useHostsStore.getState().reconnectNonce).toEqual({});
  useHostsStore.getState().setPane(paneId, { hostId: 'a', sessionId: 's1', state: 'closed' });
  openTerminalFor('a');
  expect(useHostsStore.getState().reconnectNonce).toEqual({ [paneId]: 1 });
});

it('a host is open when any of its panes is, connecting before idle', () => {
  const { setPane } = useHostsStore.getState();
  expect(useHostsStore.getState().hostStatus('a')).toBe('idle');
  setPane('p1', { hostId: 'a', sessionId: 's1', state: 'closed' });
  setPane('p2', { hostId: 'a', state: 'connecting' });
  expect(useHostsStore.getState().hostStatus('a')).toBe('connecting');
  setPane('p3', { hostId: 'a', sessionId: 's3', state: 'open' });
  expect(useHostsStore.getState().hostStatus('a')).toBe('open');
  expect(useHostsStore.getState().hostStatus('b')).toBe('idle');
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
