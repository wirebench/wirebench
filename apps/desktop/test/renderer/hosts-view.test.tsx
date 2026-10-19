import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const secretNames = vi.fn();
const setSecret = vi.fn();
const knownHosts = vi.fn();
const forgetHostKey = vi.fn();
const trustHostKey = vi.fn();
const setHostOs = vi.fn();
const sshKeys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
const localUser = vi.fn(() => Promise.resolve({ ok: true, value: { name: 'me' } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({
    ssh: {
      listHosts,
      saveHosts,
      secretNames,
      setSecret,
      knownHosts,
      forgetHostKey,
      trustHostKey,
      setHostOs,
      keys: sshKeys,
      localUser,
    },
  }),
}));
import { ToastViewport } from '../../src/renderer/components/toast.js';
import { HostsView } from '../../src/renderer/features/ssh/hosts-view.js';
import { storeSshSecret } from '../../src/renderer/features/ssh/secret-writes.js';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { useHostDetailsShown } from '../../src/renderer/features/ssh/details-shown.js';
import { HostDetails, sshCommandOf } from '../../src/renderer/features/ssh/host-details.js';
import { SshHome } from '../../src/renderer/features/ssh/ssh-home.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useForwardsStore } from '../../src/renderer/features/ssh/forwarding/forwards-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE, readUi, writeUi } from '../../src/renderer/state/ui-state.js';
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
  forwardAgent: { value: false, from: 'default' },
  proxy: { value: undefined, from: 'default' },
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
    draft: undefined,
    formDirty: false,
    discardAsk: null,
    panes: {},
    homeView: 'hosts',
    selectedHostId: undefined,
    importOpen: false,
  });
  useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
});

/** Whether Host details is wanted, as the per-machine layout keeps it. */
const detailsOpen = (): boolean => useUiStore.getState().slideOver.hostDetailsOpen === true;
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
  it('leaves a zero count out, and shows running forwards as a dot with their count', async () => {
    render(<HostsView />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('ssh-nav-keychain').textContent).toBe('Keychain2');
    });
    // No snippets, layouts or running forwards: the entries show their label only.
    expect(screen.getByTestId('ssh-nav-snippets').textContent).toBe('Snippets');
    expect(screen.getByTestId('ssh-nav-forwarding').textContent).toBe('Forwarding');
    act(() => {
      useForwardsStore.setState({
        byKey: {
          'b/db': { hostId: 'b', ruleId: 'db', port: 5432, connections: 0, status: { state: 'running' } },
        } as never,
      });
    });
    expect(screen.getByTestId('ssh-nav-forwarding-running').textContent).toBe('1');
    expect(screen.getByTestId('ssh-nav-forwarding').title).toBe('Port forwarding (1 running)');
    act(() => {
      useForwardsStore.setState({ byKey: {} });
    });
  });
  it('counts the keychain again after any keychain write, without the menu being used', async () => {
    render(<HostsView />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('ssh-nav-keychain').textContent).toBe('Keychain2');
    });
    secretNames.mockResolvedValue({
      ok: true,
      value: {
        names: [
          { name: 'DEPLOY_KEY', local: true, external: false },
          { name: 'UNSET', local: false, external: false },
          { name: 'id_ed25519', local: true, external: false },
        ],
      },
    });
    await act(async () => {
      await storeSshSecret({ name: 'id_ed25519', value: 'x' });
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId('ssh-nav-keychain').textContent).toBe('Keychain3');
    });
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
  it("lists an identity's password with the identity using it, and reads the names again after a write (S64)", async () => {
    useHostsStore.setState({
      homeView: 'keychain',
      file: {
        ...STATE.file,
        identities: [{ id: 'tester', name: 'Tester', auth: { kind: 'password', secret: 'UNSET' } }],
      },
    });
    render(<SshHome />);
    const row = await screen.findByTestId('secret-row-UNSET');
    expect(row.textContent).toContain('Used by identity Tester');
    const reads = secretNames.mock.calls.length;
    act(() => {
      useHostsStore.getState().secretsChanged();
    });
    await vi.waitFor(() => {
      expect(secretNames.mock.calls.length).toBeGreaterThan(reads);
    });
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
  it('Escape closes the New secret form and stores nothing', async () => {
    useHostsStore.setState({ homeView: 'keychain' });
    render(<SshHome />);
    await userEvent.click(screen.getAllByRole('button', { name: /New secret/ })[0]!);
    await userEvent.type(screen.getByLabelText('Secret name'), 'FRESH');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'Store a secret' })).toBeNull();
    expect(setSecret).not.toHaveBeenCalled();
  });
  it('the search narrows the names; one that hides them all offers Clear search', async () => {
    useHostsStore.setState({ homeView: 'keychain' });
    render(<SshHome />);
    await screen.findByTestId('secret-row-UNSET');
    await userEvent.type(screen.getByLabelText('Filter secrets'), 'deploy');
    expect(screen.queryByTestId('secret-row-UNSET')).toBeNull();
    expect(screen.getByTestId('secret-row-DEPLOY_KEY')).toBeDefined();
    await userEvent.type(screen.getByLabelText('Filter secrets'), '-nothing');
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('secret-row-UNSET')).toBeDefined();
  });
  it('with no secrets, offers to generate a key', async () => {
    secretNames.mockResolvedValue({ ok: true, value: { names: [] } });
    useHostsStore.setState({ homeView: 'keychain' });
    render(<SshHome />);
    const empty = await screen.findByTestId('keychain-empty');
    expect(within(empty).getByRole('button', { name: /Generate key/ })).toBeDefined();
    expect(screen.getByTestId('ssh-view-count').textContent).toBe('0');
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
  it('says which saved hosts use a key, and Undo trusts a forgotten key again', async () => {
    trustHostKey.mockResolvedValue({ ok: true, value: {} });
    useHostsStore.setState({ homeView: 'known-hosts' });
    render(
      <>
        <SshHome />
        <ToastViewport />
      </>,
    );
    const row = await screen.findByTestId('known-host-10.0.0.1:22');
    expect(row.textContent).toContain('Used by alpha');
    await userEvent.click(within(row).getByRole('button', { name: 'Forget' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    // The earlier test's toast may still be up: this Forget's is the last one.
    await userEvent.click((await screen.findAllByRole('button', { name: 'Undo' })).at(-1)!);
    expect(trustHostKey).toHaveBeenCalledWith({
      host: '10.0.0.1:22',
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      replace: false,
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
    expect(await screen.findByText('deploy · from Production')).toBeDefined();
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
  it('saving a new host stores its password as a secret and sends the whole file with only the name', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'gamma.example');
    // No group supplies a user: a plain field, prefilled with this machine's login name.
    await vi.waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    });
    expect(screen.queryByRole('switch', { name: 'Override User' })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Password' }).checked).toBe(true);
    expect(screen.queryByRole('radio', { name: 'Inherit' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Password', { selector: 'input[type="password"]' }), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'gamma_password', value: 'pw' });
    expect(saveHosts).toHaveBeenCalledTimes(1);
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts.map((h) => h.id)).toEqual(['b', 'gamma']);
    expect(sent.file.hosts[1]?.ssh).toEqual({ user: 'me', auth: { kind: 'password', secret: 'gamma_password' } });
    expect(JSON.stringify(sent.file)).not.toContain('"pw"');
  });
  it('a blank form names nothing until a required field is left empty', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    expect(screen.queryByTestId('host-form-missing')).toBeNull();
    await userEvent.click(screen.getByLabelText('Name'));
    await userEvent.tab();
    expect(screen.getByTestId('host-form-gap-name').textContent).toBe('Name is required');
  });
  it('Save on an incomplete form lists what is missing and stays off until it is filled in', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    const missing = () => screen.getByTestId('host-form-missing').textContent;
    await vi.waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    });
    expect(screen.queryByTestId('host-form-missing')).toBeNull();
    const saves = saveHosts.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveHosts.mock.calls.length).toBe(saves);
    // Each gap sits under its own field; the footer keeps one line (S59).
    expect(missing()).toBe('2 fields need a value');
    expect(screen.getByTestId('host-form-gap-name').textContent).toBe('Name is required');
    expect(screen.getByTestId('host-form-gap-address').textContent).toBe('Address is required');
    expect(screen.getByLabelText('Address').getAttribute('aria-invalid')).toBe('true');
    // The password may stay empty: it is asked for when the host connects (S60).
    expect(screen.queryByTestId('host-form-gap-auth')).toBeNull();
    expect(screen.getByText('Left empty, it is asked for when you connect.')).toBeDefined();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.type(screen.getByLabelText('Address'), 'y');
    await userEvent.clear(screen.getByLabelText('User'));
    expect(screen.queryByTestId('host-form-gap-name')).toBeNull();
    expect(screen.getByTestId('host-form-gap-user').textContent).toBe('User is required');
    expect(missing()).toBe('1 field needs a value');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('User'), 'u');
    expect(screen.queryByTestId('host-form-missing')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false);
  });
  it('a host saved with its password left empty names the secret the connection screen asks for (S60)', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await vi.waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    });
    await userEvent.type(screen.getByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'g.example');
    const stores = setSecret.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => {
      expect(saveHosts).toHaveBeenCalled();
    });
    const sent = saveHosts.mock.calls.at(-1)?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts.at(-1)?.ssh).toMatchObject({ auth: { kind: 'password', secret: 'gamma_password' } });
    expect(setSecret.mock.calls.length).toBe(stores);
  });
  it('the Group select starts on the group the list is narrowed to; the group then supplies the user', async () => {
    useHostsStore.setState({ groupFilter: 'g' });
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    expect((await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Group' })).value).toBe('g');
    expect(screen.getByText('deploy · from Production')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('User').disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Name'), 'delta');
    await userEvent.type(screen.getByLabelText('Address'), 'delta.example');
    await userEvent.type(screen.getByLabelText('Password', { selector: 'input[type="password"]' }), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.groups[0]?.hosts.map((h) => h.id)).toEqual(['a', 'delta']);
    expect(sent.file.groups[0]?.hosts[1]?.ssh).toEqual({ auth: { kind: 'password', secret: 'delta_password' } });

    // Moving it to No group brings the login name back, as nothing supplies one there.
    cleanup();
    useHostsStore.setState({ groupFilter: 'g', dialog: null });
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Group' }), '');
    await vi.waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    });
  });
  it("a group's Add host opens the dialog on that group", async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a host to Production' }));
    expect((await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Group' })).value).toBe('g');
  });
  it('a new password on an edited host replaces the value of the secret it already names', async () => {
    const file = {
      ...STATE.file,
      hosts: [{ ...STATE.file.hosts[0]!, ssh: { user: 'u', auth: { kind: 'password' as const, secret: 'beta_pw' } } }],
    };
    listHosts.mockResolvedValue({ ok: true, value: { file, resolved: STATE.resolved, problems: [] } });
    useHostsStore.setState({ file });
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Edit…'));
    const field = await screen.findByLabelText<HTMLInputElement>('Password', { selector: 'input[type="password"]' });
    expect(field.value).toBe('');
    // A short placeholder that fits a narrow panel; the secret's name is on the hint's own line (#591).
    expect(field.placeholder).toBe('•••• stored · type to replace');
    expect(screen.getByText('Stored as the secret beta_pw.').textContent).toBe('Stored as the secret beta_pw.');
    await userEvent.type(field, 'new');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'beta_pw', value: 'new' });
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof file };
    expect(sent.file.hosts[0]?.ssh.auth).toEqual({ kind: 'password', secret: 'beta_pw' });
  });
  it("an edited host's Group select moves it", async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Edit…'));
    const group = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Group' });
    expect(group.value).toBe('');
    await userEvent.selectOptions(group, 'g');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts).toEqual([]);
    expect(sent.file.groups[0]?.hosts.map((h) => h.id)).toEqual(['a', 'b']);
  });
  it('a password that could not be stored stops the save and says why', async () => {
    setSecret.mockResolvedValueOnce({
      ok: false,
      error: { code: 'workspace-not-open', message: 'Open a workspace first' },
    });
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'gamma.example');
    await userEvent.type(screen.getByLabelText('Password', { selector: 'input[type="password"]' }), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The password was not stored: Open a workspace first')).toBeDefined();
    expect(saveHosts).not.toHaveBeenCalled();
  });
  it('Duplicate opens New host filled in from the host, and writes nothing until Save', async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Duplicate'));
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('beta copy');
    expect(screen.getByTestId('host-draft-card').textContent).toContain('beta copy');
    expect(saveHosts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    const copy = sent.file.hosts.find((h) => h.id === 'b-copy');
    const original = STATE.file.hosts.find((h) => h.id === 'b');
    expect(copy).toEqual({ ...original, id: 'b-copy', name: 'beta copy' });
  });
  it('a password typed in a copy is stored as its own secret, never over the original’s', async () => {
    const withPassword = {
      ...STATE.file,
      hosts: [
        {
          id: 'b',
          name: 'beta',
          address: 'beta.example',
          tags: [],
          ssh: { user: 'me', auth: { kind: 'password' as const, secret: 'DEPLOY_KEY' } },
        },
      ],
    };
    useHostsStore.setState({ file: withPassword });
    listHosts.mockResolvedValue({ ok: true, value: { file: withPassword, resolved: STATE.resolved, problems: [] } });
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Duplicate'));
    const field = screen.getByTestId('host-dialog').querySelector<HTMLInputElement>('input[type="password"]');
    if (field === null) throw new Error('no password field');
    await userEvent.type(field, 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => {
      expect(saveHosts).toHaveBeenCalled();
    });
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(setSecret.mock.calls[0]?.[0]).not.toMatchObject({ name: 'DEPLOY_KEY' });
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof withPassword };
    expect(sent.file.hosts.find((h) => h.id === 'b')?.ssh.auth).toEqual({ kind: 'password', secret: 'DEPLOY_KEY' });
    expect(sent.file.hosts.find((h) => h.id === 'b-copy')?.ssh.auth?.secret).not.toBe('DEPLOY_KEY');
  });
  it('duplicating twice makes two distinct copies', async () => {
    render(<SshArea />);
    for (let i = 0; i < 2; i++) {
      fireEvent.contextMenu(screen.getByTestId('host-row-b'));
      await userEvent.click(await screen.findByText('Duplicate'));
      await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
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
  it('Choose a stored secret lists the names, with a hint for unset ones; Key keeps Set value… write-only', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose a stored secret' }));
    expect(await screen.findByRole('option', { name: 'DEPLOY_KEY' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'UNSET (not set on this machine)' })).toBeDefined();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Password secret' }), 'DEPLOY_KEY');
    expect(screen.queryByLabelText('Password', { selector: 'input[type="password"]' })).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: 'Key' }));
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
  it('shows up to two tags on a grid card and three in a row', async () => {
    const tags = ['db', 'eu', 'prod', 'blue'];
    useHostsStore.setState({
      file: { ...STATE.file, groups: [], hosts: [{ id: 'z', name: 'zed', address: '10.0.0.1', tags, ssh: {} }] },
    });
    render(<SshHome />);
    const shown = (): string | null => screen.getByTestId('host-tags-z').textContent;
    expect(shown()).toBe('dbeu+2');
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(shown()).toBe('dbeuprod+1');
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
  it('shows no recent section with 6 hosts or fewer: the cards already show them all', () => {
    writeRecent('w1', [{ hostId: 'b', at: Date.now() - 5 * 60_000, outcome: 'connected' }]);
    render(<SshHome />);
    expect(screen.queryByRole('region', { name: 'Recent connections' })).toBeNull();
  });
  it('the recent section lists hosts by their current name, reconnects one and clears', async () => {
    useEditorsStore.getState().reset();
    // More hosts than the strip holds, so it shows.
    const more = ['c', 'd', 'e', 'f', 'g'].map((id) => ({ ...STATE.resolved[1]!, id, name: id }));
    useHostsStore.setState({ resolved: [...STATE.resolved, ...more] });
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
    await userEvent.click(await screen.findByRole('menuitem', { name: /Import hosts/ }));
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
    expect(screen.getByTestId('hosts-empty')).toBeDefined();
    expect(within(screen.getByTestId('hosts-empty')).getByRole('button', { name: /Add host/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Import hosts…' })).toBeDefined();
  });
  it('a search that hides every host offers Clear search', async () => {
    useHostsStore.setState({ filter: 'nothing-like-this' });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(useHostsStore.getState().filter).toBe('');
    expect(screen.getByTestId('host-row-a')).toBeDefined();
  });
});

describe('Host details', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useEditorsStore.getState().showSet('ssh');
    useHostsStore.setState({ selectedHostId: undefined });
  });

  it('clicking a card picks it without opening the details', async () => {
    render(<SshHome />);
    await userEvent.click(screen.getByTestId('host-row-a'));
    expect(useHostsStore.getState().selectedHostId).toBe('a');
    expect(detailsOpen()).toBe(false);
    expect(screen.getByTestId('host-row-a').dataset['selected']).toBe('true');
  });
  it('shows where each setting comes from, the trusted key and the matching command', async () => {
    useHostsStore.setState({
      selectedHostId: 'a',
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
  it('a host with a session open leads with Go to terminal, and New session opens another (S50)', async () => {
    useHostsStore.setState({ selectedHostId: 'b', panes: { p1: { hostId: 'b', sessionId: 's1', state: 'open' } } });
    render(<HostDetails />);
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Go to terminal' }).className).toContain('bg-accent');
    const tabs = useEditorsStore.getState().tabs.length;
    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(useEditorsStore.getState().tabs.length).toBe(tabs + 1);
    useHostsStore.setState({ panes: {} });
  });
  it('lets a long value wrap rather than cutting it off (S51)', () => {
    useHostsStore.setState({ selectedHostId: 'b' });
    render(<HostDetails />);
    const value = screen.getByTestId('host-details').querySelector('dd');
    expect(value?.className).toContain('[&_.truncate]:whitespace-normal');
    expect(value?.className).toContain('flex-wrap');
  });
  it('says how many forwards run through the host, linking to Port forwarding', async () => {
    useHostsStore.setState({ selectedHostId: 'b' });
    useForwardsStore.setState({
      byKey: {
        'b/db': { hostId: 'b', ruleId: 'db', port: 5432, connections: 0, status: { state: 'starting' } },
        'a/web': { hostId: 'a', ruleId: 'web', port: 8080, connections: 0, status: { state: 'starting' } },
      } as never,
    });
    render(<HostDetails />);
    const link = screen.getByTestId('host-details-forwards');
    expect(link.textContent).toBe('1 forward running');
    await userEvent.click(link);
    expect(useHostsStore.getState().homeView).toBe('forwarding');
    act(() => {
      useForwardsStore.setState({ byKey: {} });
    });
    expect(screen.queryByTestId('host-details-forwards')).toBeNull();
  });
  it('an incomplete host says what it needs', () => {
    useHostsStore.setState({ selectedHostId: 'a' });
    render(<HostDetails />);
    expect(screen.getByRole('alert').textContent).toContain('Needs a user to connect.');
  });
  it('shows only while the Hosts tab is in front and it was not put away', () => {
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
    expect(shown()).toBe(false);
    useHostsStore.getState().setDetailsOpen(true);
    expect(shown()).toBe(true);
    openTerminalFor('b');
    expect(shown()).toBe(false);
    useEditorsStore.getState().showStart();
    expect(shown()).toBe(true);
    useHostsStore.getState().setDetailsOpen(false);
    expect(shown()).toBe(false);
    // Picking nothing does not put it away; with no host picked it asks for one.
    useHostsStore.getState().setDetailsOpen(true);
    useHostsStore.getState().selectHost(undefined);
    expect(shown()).toBe(true);
    render(<HostDetails />);
    expect(screen.getByTestId('host-details-empty').textContent).toBe('Select a host to see its details.');
  });
  it('is remembered in the per-machine layout, so it is back after a restart', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    } satisfies Storage;
    writeUi({ ...DEFAULT_UI_STATE, slideOver: { ...DEFAULT_UI_STATE.slideOver, hostDetailsOpen: true } }, fake);
    expect(readUi(fake).slideOver.hostDetailsOpen).toBe(true);
    writeUi({ ...DEFAULT_UI_STATE, slideOver: { ...DEFAULT_UI_STATE.slideOver, hostDetailsOpen: false } }, fake);
    expect(readUi(fake).slideOver.hostDetailsOpen).toBe(false);
    // A layout saved before the flag existed, or a malformed one, reads as hidden.
    writeUi(DEFAULT_UI_STATE, fake);
    expect(readUi(fake).slideOver.hostDetailsOpen).toBeUndefined();
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
    useHostsStore.setState({ selectedHostId: undefined, dialog: null });
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
  it('New host opens in the panel, with a draft card that follows the typing', async () => {
    useHostsStore.setState({ selectedHostId: 'b' });
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /^New host/ }));
    const form = await screen.findByTestId('host-dialog');
    // Not a modal: the cards stay usable beside it.
    expect(screen.queryByRole('dialog')).toBeNull();
    const draft = screen.getByTestId('host-draft-card');
    expect(draft.textContent).toContain('New host');
    // No half-built "me@" before an address is typed: the protocol alone (S45).
    expect(draft.textContent).toContain('SSH');
    expect(draft.textContent).not.toContain('@');
    const ungrouped = screen.getByRole('list', { name: 'Hosts in Ungrouped' });
    expect(within(ungrouped).getByTestId('host-draft-card')).toBe(draft);
    // First in its group while the form is open, whatever its name sorts as (S46).
    expect(ungrouped.firstElementChild).toBe(draft);
    // The draft is the picked card while the form is open.
    expect(screen.getByTestId('host-row-b').dataset['selected']).toBeUndefined();
    await userEvent.type(within(form).getByLabelText('Name'), 'gamma');
    await userEvent.type(within(form).getByLabelText('Address'), 'gamma.example');
    expect(screen.getByTestId('host-draft-card').textContent).toContain('gamma');
    expect(screen.getByTestId('host-draft-card').textContent).toContain('me@gamma.example');
    expect(screen.getByRole('list', { name: 'Hosts in Ungrouped' }).firstElementChild).toBe(
      screen.getByTestId('host-draft-card'),
    );
  });
  it('an empty group offers Add host inline, and keeps its header button in view (S49)', async () => {
    const empty = { id: 'e', name: 'Staging', tags: [], ssh: {}, groups: [], hosts: [] };
    const file = { ...STATE.file, groups: [...STATE.file.groups, empty] };
    useHostsStore.setState({ file });
    listHosts.mockResolvedValue({ ok: true, value: { file, resolved: STATE.resolved, problems: [] } });
    render(<SshArea />);
    const staging = await screen.findByRole('region', { name: 'Staging' });
    expect(within(staging).getByText(/No hosts in this group yet/)).toBeDefined();
    expect(within(staging).getByRole('button', { name: 'Add a host to Staging' }).className).not.toContain('opacity-0');
    await userEvent.click(within(staging).getByRole('button', { name: 'Add host' }));
    await screen.findByTestId('host-dialog');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Group' }).value).toBe('e');
  });
  it('the draft sits in the group it will be saved to, and moves with the Group select', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a host to Production' }));
    const production = screen.getByRole('list', { name: 'Hosts in Production' });
    expect(within(production).getByTestId('host-draft-card')).toBeDefined();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Group' }), '');
    expect(
      within(screen.getByRole('list', { name: 'Hosts in Ungrouped' })).getByTestId('host-draft-card'),
    ).toBeDefined();
  });
  it('Save turns the draft into the saved host and picks it', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /^New host/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'gamma.example');
    await userEvent.type(screen.getByLabelText('Password', { selector: 'input[type="password"]' }), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => {
      expect(useHostsStore.getState().dialog).toBeNull();
    });
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts.at(-1)).toMatchObject({ id: 'gamma', name: 'gamma', address: 'gamma.example' });
    expect(useHostsStore.getState().selectedHostId).toBe('gamma');
    expect(screen.queryByTestId('host-draft-card')).toBeNull();
  });
  it('Cancel on an untouched form drops the draft without asking', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /^New host/ }));
    await screen.findByTestId('host-draft-card');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('host-discard')).toBeNull();
    expect(screen.queryByTestId('host-draft-card')).toBeNull();
    expect(useHostsStore.getState().dialog).toBeNull();
  });
  it('leaving a New host form with typing asks first; Discard drops it, Cancel keeps it', async () => {
    render(<SshArea />);
    await userEvent.click(screen.getByRole('button', { name: /^New host/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'gamma');
    // Escape in a field leaves the form the same way.
    await userEvent.keyboard('{Escape}');
    const ask = await screen.findByTestId('host-discard');
    expect(ask.textContent).toContain('Discard changes?');
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(useHostsStore.getState().dialog?.mode).toBe('new-host');
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('gamma');
    // Putting the panel away asks too.
    act(() => {
      useHostsStore.getState().setDetailsOpen(false);
    });
    await userEvent.click(within(await screen.findByTestId('host-discard')).getByRole('button', { name: 'Discard' }));
    expect(useHostsStore.getState().dialog).toBeNull();
    expect(screen.queryByTestId('host-draft-card')).toBeNull();
    // The panel is left as it was: New host only borrowed it.
    expect(detailsOpen()).toBe(false);
  });
  it('Edit host with changes asks before picking another host drops them', async () => {
    render(<SshArea />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Edit…'));
    await vi.waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await userEvent.type(screen.getByLabelText('Name'), ' two');
    await userEvent.click(screen.getByTestId('host-row-a'));
    const ask = await screen.findByTestId('host-discard');
    expect(useHostsStore.getState().selectedHostId).toBe('b');
    await userEvent.click(within(ask).getByRole('button', { name: 'Discard' }));
    expect(useHostsStore.getState().dialog).toBeNull();
    expect(useHostsStore.getState().selectedHostId).toBe('a');
  });
});

describe('Clicking the picked card', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useEditorsStore.getState().showSet('ssh');
  });

  it('keeps its details showing; another card shows that host instead', async () => {
    useHostsStore.getState().setDetailsOpen(true);
    render(<SshHome />);
    const card = screen.getByTestId('host-row-b');
    await userEvent.click(card);
    expect(useHostsStore.getState().selectedHostId).toBe('b');
    expect(detailsOpen()).toBe(true);
    await userEvent.click(card);
    await userEvent.click(card);
    expect(useHostsStore.getState().selectedHostId).toBe('b');
    expect(detailsOpen()).toBe(true);
    await userEvent.click(screen.getByTestId('host-row-a'));
    expect(useHostsStore.getState().selectedHostId).toBe('a');
    expect(detailsOpen()).toBe(true);
  });
  it('has no Connect button: a double-click connects', async () => {
    render(<SshHome />);
    expect(within(screen.getByTestId('host-row-b')).queryByRole('button', { name: 'Connect' })).toBeNull();
    await userEvent.dblClick(screen.getByTestId('host-row-b'));
    expect(activeTerminalHost()).toBe('b');
  });
});

describe('Group headings', () => {
  it("no chips repeat the sections; the heading's ⋯ shows only that group, and the bar shows all again", async () => {
    render(<SshHome />);
    expect(screen.queryByRole('group', { name: 'Filter by group' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Production' }));
    expect(await screen.findByRole('menuitem', { name: 'New host here…' })).toBeDefined();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Show only this group' }));
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();
    expect(screen.getByTestId('hosts-group-filter').textContent).toContain('Showing only Production');

    await userEvent.click(screen.getByRole('button', { name: 'Show all groups' }));
    expect(screen.queryByTestId('hosts-group-filter')).toBeNull();
    expect(screen.getByText('beta')).toBeDefined();
  });
  it("a card double-click whose second press lands on a heading's ⋯ connects, and the menu stays shut", () => {
    useEditorsStore.getState().reset();
    render(<SshHome />);
    // The first press opens the details, the header wraps, and the heading moves under the pointer.
    fireEvent.mouseDown(screen.getByTestId('host-row-a'), { detail: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Production' }), {
      button: 0,
      clientX: 41,
      clientY: 40,
    });
    expect(activeTerminalHost()).toBe('a');
    expect(screen.queryByRole('menuitem', { name: 'New host here…' })).toBeNull();
  });
  it('the ungrouped section has no ⋯', () => {
    render(<SshHome />);
    expect(screen.queryByRole('button', { name: 'More actions for Ungrouped' })).toBeNull();
  });
});

describe('Host OS', () => {
  const ubuntu = { detected: { id: 'ubuntu' as const, name: 'Ubuntu', version: '22.04' } };

  it('the card shows what the last connection found on its icon, and still leads with the target (S56)', () => {
    useHostsStore.setState({ osByHost: { '10.0.0.1:22': ubuntu } });
    render(<SshHome />);
    const card = screen.getByTestId('host-row-a');
    expect(card.querySelector('[title="Ubuntu 22.04"]')).not.toBeNull();
    expect(card.textContent).not.toContain('Ubuntu');
    expect(card.textContent).toContain('10.0.0.1');
    expect(screen.getByTestId('host-row-b').querySelector('[title^="Ubuntu"]')).toBeNull();
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
