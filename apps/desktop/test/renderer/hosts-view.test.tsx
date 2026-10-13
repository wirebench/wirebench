import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const secretNames = vi.fn();
const setSecret = vi.fn();
const knownHosts = vi.fn();
const forgetHostKey = vi.fn();
const setHostOs = vi.fn();
const sshKeys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({
    ssh: { listHosts, saveHosts, secretNames, setSecret, knownHosts, forgetHostKey, setHostOs, keys: sshKeys },
  }),
}));
import { HostsView } from '../../src/renderer/features/ssh/hosts-view.js';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { HostDetails, sshCommandOf, useHostDetailsShown } from '../../src/renderer/features/ssh/host-details.js';
import { SshHome } from '../../src/renderer/features/ssh/ssh-home.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { DEFAULT_HOSTS_PREFS, readHostsPrefs, writeHostsPrefs } from '../../src/renderer/features/ssh/hosts-prefs.js';
import type { WorkspaceWire } from '../../src/shared/wire-base.js';
import { readRecent, writeRecent } from '../../src/renderer/features/ssh/recent-connections.js';

/** The host of the terminal tab in front (its one pane). */
const activeTerminalHost = (): string | undefined => {
  const { tabs, activeId } = useEditorsStore.getState();
  const panes = tabs.find((t) => t.id === activeId)?.panes;
  return panes?.kind === 'pane' ? panes.hostId : undefined;
};

const defaults = {
  user: { value: undefined, from: 'default' },
  port: { value: 22, from: 'default' },
  auth: { value: undefined, from: 'default' },
  jump: { value: undefined, from: 'default' },
  keepAlive: { value: 15, from: 'default' },
  connectTimeout: { value: 20, from: 'default' },
} as const;
const STATE = {
  file: {
    version: 1 as const,
    groups: [
      {
        id: 'g',
        name: 'Production',
        tags: [],
        ssh: { user: 'deploy' },
        groups: [],
        hosts: [{ id: 'a', name: 'alpha', address: '10.0.0.1', tags: ['prod'], ssh: {} }],
      },
    ],
    hosts: [{ id: 'b', name: 'beta', address: 'beta.example', tags: [], ssh: {} }],
  },
  resolved: [
    {
      id: 'a',
      name: 'alpha',
      address: '10.0.0.1',
      tags: ['prod'],
      path: ['g'],
      protected: { value: false, from: 'default' as const },
      ssh: defaults,
      forwards: [],
      env: [],
      incomplete: { field: 'user' as const },
    },
    {
      id: 'b',
      name: 'beta',
      address: 'beta.example',
      tags: [],
      path: [],
      protected: { value: false, from: 'default' as const },
      ssh: defaults,
      forwards: [],
      env: [],
    },
  ],
  problems: [{ code: 'ssh-bad-yaml', message: 'could not parse' }],
  loaded: true,
};

beforeEach(() => {
  listHosts.mockResolvedValue({
    ok: true,
    value: { file: STATE.file, resolved: STATE.resolved, problems: STATE.problems },
  });
  saveHosts.mockResolvedValue({ ok: true, value: { file: STATE.file, resolved: STATE.resolved, problems: [] } });
  secretNames.mockResolvedValue({
    ok: true,
    value: {
      names: [
        { name: 'DEPLOY_KEY', local: true, external: false },
        { name: 'UNSET', local: false, external: false },
      ],
    },
  });
  setSecret.mockResolvedValue({ ok: true, value: {} });
  knownHosts.mockResolvedValue({
    ok: true,
    value: { entries: [{ host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }] },
  });
  forgetHostKey.mockResolvedValue({ ok: true, value: {} });
  setHostOs.mockReset();
  setHostOs.mockResolvedValue({ ok: true, value: {} });
  useHostsStore.setState({
    ...STATE,
    filter: '',
    selectedTags: [],
    groupFilter: undefined,
    osByHost: {},
    dialog: null,
    panes: {},
    homeView: 'hosts',
    selectedHostId: undefined,
    detailsOpen: false,
    importOpen: false,
  });
});
afterEach(cleanup);

/** The sidebar menu and the fixed tab it drives, as the shell lays them out. */
function SshArea() {
  return (
    <>
      <HostsView />
      <SshHome />
      <HostDetails />
    </>
  );
}

describe('SSH menu', () => {
  it('lists Hosts, Keychain and Known hosts with their counts', async () => {
    render(<HostsView />);
    const nav = screen.getByRole('navigation', { name: 'SSH' });
    expect(nav.textContent).toContain('Hosts2');
    expect(await screen.findByText('Keychain')).toBeDefined();
    await vi.waitFor(() => {
      expect(screen.getByTestId('ssh-nav-keychain').textContent).toBe('Keychain2');
      expect(screen.getByTestId('ssh-nav-known-hosts').textContent).toBe('Known hosts1');
    });
    // The sidebar no longer draws the hosts themselves.
    expect(screen.queryByText('alpha')).toBeNull();
  });
  it('picking an entry brings the fixed tab of the SSH set to the front', async () => {
    useEditorsStore.getState().reset();
    openTerminalFor('b');
    render(<SshArea />);
    await userEvent.click(screen.getByTestId('ssh-nav-keychain'));
    expect(useHostsStore.getState().homeView).toBe('keychain');
    expect(useEditorsStore.getState().displayedSet).toBe('ssh');
    expect(useEditorsStore.getState().activeId).toBeUndefined();
    expect(screen.getByTestId('ssh-nav-keychain').getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('DEPLOY_KEY')).toBeDefined();
  });
});

describe('Keychain', () => {
  it('lists each name with where its value lives and the hosts using it', async () => {
    useHostsStore.setState({
      homeView: 'keychain',
      resolved: [
        {
          ...STATE.resolved[1]!,
          ssh: { ...defaults, auth: { value: { kind: 'key', secret: 'DEPLOY_KEY' }, from: 'host' } },
        },
      ],
    });
    render(<SshHome />);
    const row = await screen.findByTestId('secret-row-DEPLOY_KEY');
    expect(row.textContent).toContain('Used by beta');
    expect(row.textContent).toContain('on this machine');
    expect(screen.getByTestId('secret-row-UNSET').textContent).toContain('no value');
  });
  it('Set value… stores the value write-only and reloads the names', async () => {
    useHostsStore.setState({ homeView: 'keychain' });
    render(<SshHome />);
    const row = await screen.findByTestId('secret-row-UNSET');
    await userEvent.click(within(row).getByRole('button', { name: 'Set value…' }));
    expect(screen.getByLabelText<HTMLInputElement>('Secret name').readOnly).toBe(true);
    await userEvent.type(screen.getByLabelText('Secret value'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Store' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'UNSET', value: 'pw' });
    await vi.waitFor(() => {
      expect(secretNames).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByLabelText('Secret value')).toBeNull();
  });
  it('New secret takes a name and a value', async () => {
    useHostsStore.setState({ homeView: 'keychain' });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /New secret/ }));
    await userEvent.type(screen.getByLabelText('Secret name'), 'FRESH');
    await userEvent.type(screen.getByLabelText('Secret value'), 'v');
    await userEvent.click(screen.getByRole('button', { name: 'Store' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'FRESH', value: 'v' });
  });
});

describe('Known hosts', () => {
  it('lists trusted keys and forgets one after confirming', async () => {
    useHostsStore.setState({ homeView: 'known-hosts' });
    render(<SshHome />);
    const row = await screen.findByTestId('known-host-10.0.0.1:22');
    expect(row.textContent).toContain('ssh-ed25519 SHA256:abc');
    await userEvent.click(within(row).getByRole('button', { name: 'Forget' }));
    expect(forgetHostKey).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    expect(forgetHostKey).toHaveBeenCalledWith({ host: '10.0.0.1:22', keyType: 'ssh-ed25519' });
    await vi.waitFor(() => {
      expect(knownHosts).toHaveBeenCalledTimes(2);
    });
  });
  it('says so when nothing is trusted yet', async () => {
    knownHosts.mockResolvedValue({ ok: true, value: { entries: [] } });
    useHostsStore.setState({ homeView: 'known-hosts' });
    render(<SshHome />);
    expect(await screen.findByText(/No trusted host keys yet/)).toBeDefined();
  });
});

describe('Hosts tab', () => {
  it('renders groups, hosts, the needs-badge and the problem banner', () => {
    render(<SshArea />);
    expect(screen.getByRole('region', { name: 'Production' })).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.getByText('needs user')).toBeDefined();
    expect(screen.getByText('ssh-bad-yaml')).toBeDefined();
  });
  it('the filter narrows the tree', async () => {
    render(<SshArea />);
    await userEvent.type(screen.getByLabelText('Filter hosts'), 'beta');
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Production' })).toBeNull();
    expect(screen.getByText('beta')).toBeDefined();
  });
  it('editing a host inside a group shows the inherited user with its group', async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-a'));
    await userEvent.click(await screen.findByText('Edit…'));
    expect(await screen.findByText('from Production')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('User').disabled).toBe(true);
  });
  it('double-clicking a host opens its terminal tab', async () => {
    useEditorsStore.getState().reset();
    render(<SshArea />);
    await userEvent.dblClick(screen.getByTestId('host-row-b'));
    expect(useEditorsStore.getState().tabs).toEqual([
      {
        id: expect.stringMatching(/^ssh-terminal:/) as unknown,
        kind: 'ssh-terminal',
        title: 'beta',
        panes: { kind: 'pane', paneId: expect.any(String) as unknown, hostId: 'b' },
      },
    ]);
    expect(useEditorsStore.getState().activeId).toBe(useEditorsStore.getState().tabs[0]?.id);
  });
  it('the second press connects the host the first picked, even when the card moved from under it', () => {
    useEditorsStore.getState().reset();
    render(<SshArea />);
    // The first press opens the details, and the content narrowing moves the cards: the second
    // press, at the same spot, lands on another card.
    fireEvent.mouseDown(screen.getByTestId('host-row-b'), { detail: 1, clientX: 40, clientY: 40 });
    fireEvent.mouseDown(screen.getByTestId('host-row-a'), { detail: 2, clientX: 41, clientY: 40 });
    expect(useEditorsStore.getState().tabs.map((t) => t.panes)).toMatchObject([{ hostId: 'b' }]);
  });
  it('two presses far apart connect nothing', () => {
    useEditorsStore.getState().reset();
    render(<SshArea />);
    fireEvent.mouseDown(screen.getByTestId('host-row-b'), { detail: 1, clientX: 40, clientY: 40 });
    fireEvent.mouseDown(screen.getByTestId('host-row-a'), { detail: 2, clientX: 300, clientY: 40 });
    expect(useEditorsStore.getState().tabs).toEqual([]);
  });
  it('a connected host shows it in its row', () => {
    useHostsStore.setState({ panes: { p1: { hostId: 'b', sessionId: 's1', state: 'open' } } });
    render(<SshArea />);
    expect(screen.getByLabelText('connected')).toBeDefined();
  });
  it('saving a new host sends the whole file', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'gamma.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveHosts).toHaveBeenCalledTimes(1);
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts.map((h) => h.id)).toEqual(['b', 'gamma']);
  });
  it('duplicating twice makes two distinct copies', async () => {
    render(<SshArea />);
    for (let i = 0; i < 2; i++) {
      fireEvent.contextMenu(screen.getByTestId('host-row-b'));
      await userEvent.click(await screen.findByText('Duplicate'));
      const sent = saveHosts.mock.calls[i]?.[0] as { file: typeof STATE.file };
      useHostsStore.setState({ file: sent.file });
    }
    const last = saveHosts.mock.calls[1]?.[0] as { file: typeof STATE.file };
    expect(last.file.hosts.map((h) => h.id)).toEqual(['b', 'b-copy', 'b-copy-2']);
  });
  it('a host missing from resolved still renders, degraded', () => {
    useHostsStore.setState({ resolved: STATE.resolved.filter((r) => r.id !== 'b') });
    render(<SshArea />);
    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.getByText('unresolved')).toBeDefined();
  });
  it('Move to… lists the top level and other groups and moves the host', async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Move to…'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Production' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts).toEqual([]);
    expect(sent.file.groups[0]?.hosts.map((h) => h.id)).toEqual(['a', 'b']);
  });
  it('the auth picker lists names with a hint for unset ones and Set value stores write-only', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.click(await screen.findByRole('radio', { name: 'Password' }));
    expect(await screen.findByRole('option', { name: 'DEPLOY_KEY' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'UNSET (not set on this machine)' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Set value…' }));
    await userEvent.type(screen.getByLabelText('Secret name'), 'NEW_ONE');
    await userEvent.type(screen.getByLabelText('Secret value'), 'pw');
    const before = secretNames.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Store' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'NEW_ONE', value: 'pw' });
    await vi.waitFor(() => {
      expect(secretNames.mock.calls.length).toBeGreaterThan(before);
    });
  });
  it('Save stays disabled until a password secret is chosen', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'x');
    await userEvent.type(screen.getByLabelText('Address'), 'y');
    await userEvent.click(screen.getByRole('radio', { name: 'Password' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });
});

describe('Hosts tab view', () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspace: { id: 'w1' } as WorkspaceWire });
  });

  it('folding a group hides its hosts and is remembered for the workspace', async () => {
    render(<SshHome />);
    await userEvent.click(
      within(screen.getByRole('region', { name: 'Production' })).getByRole('button', { name: /^Production/ }),
    );
    expect(screen.queryByText('alpha')).toBeNull();
    expect(readHostsPrefs('w1').collapsed).toEqual(['g']);
    cleanup();
    render(<SshHome />);
    expect(screen.queryByText('alpha')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Production' }))
        .getByRole('button', { name: /^Production/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });
  it('a search opens folded groups to show what matches', async () => {
    writeHostsPrefs('w1', { ...DEFAULT_HOSTS_PREFS, collapsed: ['g'] });
    render(<SshHome />);
    expect(screen.queryByText('alpha')).toBeNull();
    await userEvent.type(screen.getByLabelText('Filter hosts'), 'alp');
    expect(screen.getByText('alpha')).toBeDefined();
  });
  it('sorts within a section and switches to the list layout', async () => {
    useHostsStore.setState({
      file: {
        ...STATE.file,
        groups: [],
        hosts: [
          { id: 'z', name: 'zed', address: '10.0.0.1', tags: [], ssh: {} },
          { id: 'y', name: 'yak', address: '10.0.0.2', tags: [], ssh: {} },
        ],
      },
      panes: { p1: { hostId: 'z', sessionId: 's', state: 'open' } },
    });
    render(<SshHome />);
    const names = (): string[] => screen.getAllByTestId(/^host-row-/).map((el) => el.dataset['hostCard'] ?? '');
    expect(names()).toEqual(['y', 'z']);
    await userEvent.click(screen.getByRole('button', { name: /Sort by/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Connected first' }));
    expect(names()).toEqual(['z', 'y']);
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    expect(readHostsPrefs('w1')).toMatchObject({ layout: 'list', sort: 'connected' });
  });
  it('sorts by the last connect, hosts never connected to last', async () => {
    useHostsStore.setState({
      file: {
        ...STATE.file,
        groups: [],
        hosts: [
          { id: 'z', name: 'zed', address: '10.0.0.1', tags: [], ssh: {} },
          { id: 'y', name: 'yak', address: '10.0.0.2', tags: [], ssh: {} },
          { id: 'x', name: 'xray', address: '10.0.0.3', tags: [], ssh: {} },
        ],
      },
    });
    writeRecent('w1', [
      { hostId: 'z', at: 5, outcome: 'failed' },
      { hostId: 'y', at: 3, outcome: 'connected' },
    ]);
    render(<SshHome />);
    const names = (): string[] => screen.getAllByTestId(/^host-row-/).map((el) => el.dataset['hostCard'] ?? '');
    await userEvent.click(screen.getByRole('button', { name: /Sort by/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Recently connected' }));
    expect(names()).toEqual(['z', 'y', 'x']);
    expect(readHostsPrefs('w1').sort).toBe('recent');
  });
  it('shows no recent section before any connect', () => {
    render(<SshHome />);
    expect(screen.queryByRole('region', { name: 'Recent connections' })).toBeNull();
  });
  it('the recent section lists hosts by their current name, reconnects one and clears', async () => {
    useEditorsStore.getState().reset();
    writeRecent('w1', [
      { hostId: 'b', at: Date.now() - 5 * 60_000, outcome: 'failed' },
      { hostId: 'deleted', at: Date.now() - 6 * 60_000, outcome: 'connected' },
      { hostId: 'a', at: Date.now() - 7 * 60_000, outcome: 'connected' },
    ]);
    render(<SshHome />);
    const recent = screen.getByRole('region', { name: 'Recent connections' });
    const rows = within(recent).getAllByRole('listitem');
    expect(rows.map((row) => row.dataset['hostId'])).toEqual(['b', 'a']);
    expect(rows[0]?.textContent).toContain('beta');
    expect(rows[0]?.textContent).toContain('Failed');
    expect(rows[0]?.textContent).toContain('5 min ago');
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Connect to beta' }));
    expect(activeTerminalHost()).toBe('b');
    await userEvent.click(within(recent).getByRole('button', { name: 'Clear recent connections' }));
    expect(readRecent('w1')).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Recent connections' })).toBeNull();
  });
  it('arrow keys move the selection and Enter connects the selected host', async () => {
    useEditorsStore.getState().reset();
    render(<SshHome />);
    const first = screen.getByTestId('host-row-b');
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByTestId('host-row-a'));
    await userEvent.keyboard('{Enter}');
    expect(activeTerminalHost()).toBe('a');
  });
  it('the ⋯ menu offers the same actions as right-click', async () => {
    useEditorsStore.getState().reset();
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: 'More actions for beta' }));
    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeDefined();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Connect' }));
    expect(activeTerminalHost()).toBe('b');
  });
  it('New host ▾ offers a group and the SSH config import', async () => {
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: 'More ways to add' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Import from SSH config/ }));
    expect(useHostsStore.getState().importOpen).toBe(true);
  });
  it('Mod+F focuses the search', () => {
    render(<SshHome />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Filter hosts'));
  });
  it('with no hosts, offers the first one and the import', () => {
    useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [] });
    render(<SshHome />);
    expect(screen.getByText('Add your first host')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Import from SSH config' })).toBeDefined();
  });
});

describe('Host details', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useEditorsStore.getState().showSet('ssh');
    useHostsStore.setState({ selectedHostId: undefined, detailsOpen: false });
  });

  it('clicking a card picks it and asks for its details', async () => {
    render(<SshHome />);
    await userEvent.click(screen.getByTestId('host-row-a'));
    expect(useHostsStore.getState()).toMatchObject({ selectedHostId: 'a', detailsOpen: true });
    expect(screen.getByTestId('host-row-a').dataset['selected']).toBe('true');
  });
  it('shows where each setting comes from, the trusted key and the matching command', async () => {
    useHostsStore.setState({
      selectedHostId: 'a',
      detailsOpen: true,
      resolved: [
        {
          ...STATE.resolved[0]!,
          incomplete: undefined,
          ssh: {
            ...defaults,
            user: { value: 'deploy', from: { group: 'g' } },
            auth: { value: { kind: 'key', secret: 'DEPLOY_KEY' }, from: 'host' },
          },
        },
        STATE.resolved[1]!,
      ],
    });
    render(<HostDetails />);
    const details = screen.getByTestId('host-details');
    expect(details.textContent).toContain('from Production');
    expect(details.textContent).toContain('value on this machine');
    expect(await screen.findByText('SHA256:abc')).toBeDefined();
    expect(screen.getByText('ssh deploy@10.0.0.1')).toBeDefined();
  });
  it('an incomplete host says what it needs', () => {
    useHostsStore.setState({ selectedHostId: 'a', detailsOpen: true });
    render(<HostDetails />);
    expect(screen.getByRole('alert').textContent).toContain('Needs a user to connect.');
  });
  it('shows only while the Hosts tab is in front and a host is picked', () => {
    const shown = (): boolean => {
      let value = false;
      function Probe() {
        value = useHostDetailsShown();
        return null;
      }
      render(<Probe />);
      cleanup();
      return value;
    };
    expect(shown()).toBe(false);
    useHostsStore.getState().selectHost('b');
    expect(shown()).toBe(true);
    openTerminalFor('b');
    expect(shown()).toBe(false);
    useEditorsStore.getState().showStart();
    expect(shown()).toBe(true);
    useHostsStore.getState().setDetailsOpen(false);
    expect(shown()).toBe(false);
  });
  it('builds the ssh command with the port and jump host only when they differ', () => {
    const host = {
      ...STATE.resolved[1]!,
      ssh: { ...defaults, port: { value: 2222, from: 'host' as const } },
    };
    expect(sshCommandOf(host, 'ops@bastion')).toBe('ssh -p 2222 -J ops@bastion beta.example');
  });
});

describe('Editing in the details panel', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useHostsStore.setState({ selectedHostId: undefined, detailsOpen: false, dialog: null });
  });

  it('Edit opens the form in the panel, not a dialog, and Save returns to the details', async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Edit…'));
    await vi.waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(screen.getByTestId('host-edit')).toBeDefined();
    expect(screen.queryByTestId('host-dialog')).toBeNull();
    expect(useEditorsStore.getState().displayedSet).toBe('ssh');
    const name = screen.getByLabelText<HTMLInputElement>('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'beta two');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts[0]?.name).toBe('beta two');
    expect(screen.queryByTestId('host-edit')).toBeNull();
    expect(screen.getByTestId('host-details')).toBeDefined();
  });
  it('picking another host or putting the panel away leaves the edit', async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Edit…'));
    await vi.waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await userEvent.click(screen.getByTestId('host-row-a'));
    expect(useHostsStore.getState().dialog).toBeNull();
    expect(screen.queryByTestId('host-edit')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('host-row-a'));
    await userEvent.click(await screen.findByText('Edit…'));
    useHostsStore.getState().setDetailsOpen(false);
    expect(useHostsStore.getState().dialog).toBeNull();
  });
  it('New host still opens the dialog', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /^New host/ }));
    expect(await screen.findByTestId('host-dialog')).toBeDefined();
  });
});

describe('Clicking the picked card', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useEditorsStore.getState().showSet('ssh');
  });

  it('hides its details, and a further click shows them again', async () => {
    render(<SshHome />);
    const card = screen.getByTestId('host-row-b');
    await userEvent.click(card);
    expect(useHostsStore.getState()).toMatchObject({ selectedHostId: 'b', detailsOpen: true });
    await userEvent.click(card);
    expect(useHostsStore.getState()).toMatchObject({ selectedHostId: 'b', detailsOpen: false });
    await userEvent.click(card);
    expect(useHostsStore.getState().detailsOpen).toBe(true);
  });
  it('has no Connect button: a double-click connects', async () => {
    render(<SshHome />);
    expect(within(screen.getByTestId('host-row-b')).queryByRole('button', { name: 'Connect' })).toBeNull();
    await userEvent.dblClick(screen.getByTestId('host-row-b'));
    expect(activeTerminalHost()).toBe('b');
  });
});

describe('Group chips', () => {
  it('show every group with its count; picking one filters, picking it again clears', async () => {
    render(<SshHome />);
    const chips = screen.getByRole('group', { name: 'Filter by group' });
    const all = within(chips).getByRole('button', { name: /^All/ });
    const production = within(chips).getByRole('button', { name: /^Production/ });
    expect(all.textContent).toBe('All 2');
    expect(production.textContent).toBe('Production 1');
    expect(all.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(production);
    expect(production.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();

    await userEvent.click(production);
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('beta')).toBeDefined();
  });
  it('a nested group is named by its path and counts the hosts inside it', () => {
    const file = {
      ...STATE.file,
      groups: [
        {
          ...STATE.file.groups[0]!,
          groups: [
            {
              id: 'eu',
              name: 'EU',
              tags: [],
              ssh: {},
              groups: [],
              hosts: [{ id: 'c', name: 'gamma', address: '10.0.0.3', tags: [], ssh: {} }],
            },
          ],
        },
      ],
    };
    useHostsStore.setState({ file });
    render(<SshHome />);
    const chips = screen.getByRole('group', { name: 'Filter by group' });
    expect(within(chips).getByRole('button', { name: /^Production \/ EU/ }).textContent).toBe('Production / EU 1');
    expect(within(chips).getByRole('button', { name: /^Production 2/ })).toBeDefined();
    expect(within(chips).getByRole('button', { name: /^All/ }).textContent).toBe('All 3');
  });
  it('no groups, no chips', () => {
    useHostsStore.setState({ file: { ...STATE.file, groups: [] } });
    render(<SshHome />);
    expect(screen.queryByRole('group', { name: 'Filter by group' })).toBeNull();
  });
});

describe('Host OS', () => {
  const ubuntu = { detected: { id: 'ubuntu' as const, name: 'Ubuntu', version: '22.04' } };

  it('the card shows what the last connection found', () => {
    useHostsStore.setState({ osByHost: { '10.0.0.1:22': ubuntu } });
    render(<SshHome />);
    expect(screen.getByTestId('host-row-a').textContent).toContain('Ubuntu 22.04');
    expect(screen.getByTestId('host-row-b').textContent).not.toContain('Ubuntu');
  });
  it('the details say whether it was detected or chosen', () => {
    useHostsStore.setState({ osByHost: { '10.0.0.1:22': ubuntu }, selectedHostId: 'a' });
    const { unmount } = render(<HostDetails />);
    expect(screen.getByTestId('host-details').textContent).toContain('Ubuntu 22.04detected');
    unmount();
    useHostsStore.setState({ osByHost: { '10.0.0.1:22': { ...ubuntu, chosen: 'debian' } } });
    render(<HostDetails />);
    expect(screen.getByTestId('host-details').textContent).toContain('Debianset by you');
  });
  it('choosing an OS in Edit stores it for the host on this machine', async () => {
    useHostsStore.setState({ osByHost: { '10.0.0.1:22': ubuntu }, selectedHostId: 'a' });
    useHostsStore.setState({ dialog: { mode: 'edit-host', id: 'a' } });
    render(<HostDetails />);
    const select = screen.getByLabelText<HTMLSelectElement>('OS');
    expect(select.value).toBe('');
    expect(select.options[0]?.textContent).toBe('Auto (Ubuntu)');
    await userEvent.selectOptions(select, 'debian');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setHostOs).toHaveBeenCalledWith({ host: '10.0.0.1:22', os: 'debian' });
  });
  it('saving an edited host keeps its forwarding rules', async () => {
    const forwards = [{ id: 'pg', type: 'local' as const, port: 5432, target: 'db:5432' }];
    const group = STATE.file.groups[0] as (typeof STATE.file.groups)[number];
    useHostsStore.setState({
      file: { ...STATE.file, groups: [{ ...group, hosts: [{ ...group.hosts[0]!, forwards }] }] },
      selectedHostId: 'a',
      dialog: { mode: 'edit-host', id: 'a' },
    });
    render(<HostDetails />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.groups[0]?.hosts[0]).toMatchObject({ id: 'a', forwards });
  });
  it('saving without touching the OS stores nothing', async () => {
    useHostsStore.setState({ selectedHostId: 'a', dialog: { mode: 'edit-host', id: 'a' } });
    render(<HostDetails />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveHosts).toHaveBeenCalled();
    expect(setHostOs).not.toHaveBeenCalled();
  });
});
