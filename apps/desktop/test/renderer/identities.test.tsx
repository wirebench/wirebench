import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const secretNames = vi.fn();
const setSecret = vi.fn();
const setHostOs = vi.fn();
const sshKeys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
const localUser = vi.fn(() => Promise.resolve({ ok: true, value: { name: 'me' } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, secretNames, setSecret, setHostOs, keys: sshKeys, localUser } }),
}));
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';
import { HostDialog } from '../../src/renderer/features/ssh/host-dialog.js';
import {
  inheritedFrom,
  inheritedLogin,
  sshPreferenceDefaults,
} from '../../src/renderer/features/ssh/host-form-model.js';
import { sourceText } from '../../src/renderer/features/ssh/inherited-field.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import {
  freeIdentityId,
  identityHosts,
  identityReferences,
  removeIdentity,
  upsertIdentity,
} from '../../src/renderer/features/ssh/identities.js';
import { SshHome } from '../../src/renderer/features/ssh/ssh-home.js';

const FILE: HostsFileWire = {
  version: 1,
  identities: [
    { id: 'deploy', name: 'Deploy', user: 'deploy', auth: { kind: 'key', secret: 'DEPLOY_KEY' } },
    { id: 'spare', name: 'Spare', user: 'spare' },
  ],
  groups: [
    {
      id: 'g',
      name: 'Production',
      tags: [],
      ssh: { identity: 'deploy' },
      groups: [],
      hosts: [{ id: 'a', name: 'alpha', address: '10.0.0.1', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'b', name: 'beta', address: 'beta.example', tags: [], ssh: { identity: 'deploy', user: 'root' } }],
};

const base = {
  port: { value: 22, from: 'default' },
  jump: { value: undefined, from: 'default' },
  keepAlive: { value: 15, from: 'default' },
  connectTimeout: { value: 20, from: 'default' },
  forwardAgent: { value: false, from: 'default' },
  proxy: { value: undefined, from: 'default' },
} as const;
const RESOLVED: ResolvedHostWire[] = [
  {
    id: 'a',
    name: 'alpha',
    address: '10.0.0.1',
    tags: [],
    path: ['g'],
    protected: { value: false, from: 'default' },
    ssh: {
      ...base,
      identity: { value: 'deploy', from: { group: 'g' } },
      user: { value: 'deploy', from: { identity: 'deploy' } },
      auth: { value: { kind: 'key', secret: 'DEPLOY_KEY' }, from: { identity: 'deploy' } },
    },
    forwards: [],
    env: [],
  },
  {
    id: 'b',
    name: 'beta',
    address: 'beta.example',
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: {
      ...base,
      identity: { value: 'deploy', from: 'host' },
      user: { value: 'root', from: 'host' },
      auth: { value: { kind: 'key', secret: 'DEPLOY_KEY' }, from: { identity: 'deploy' } },
    },
    forwards: [],
    env: [],
  },
];

beforeEach(() => {
  listHosts.mockResolvedValue({ ok: true, value: { file: FILE, resolved: RESOLVED, problems: [] } });
  saveHosts.mockReset();
  saveHosts.mockResolvedValue({ ok: true, value: { file: FILE, resolved: RESOLVED, problems: [] } });
  secretNames.mockResolvedValue({ ok: true, value: { names: [{ name: 'DEPLOY_KEY', local: true, external: false }] } });
  setSecret.mockReset();
  setSecret.mockResolvedValue({ ok: true, value: {} });
  useHostsStore.setState({
    file: FILE,
    resolved: RESOLVED,
    problems: [],
    loaded: true,
    filter: '',
    selectedTags: [],
    groupFilter: undefined,
    osByHost: {},
    dialog: null,
    panes: {},
    homeView: 'keychain',
    selectedHostId: undefined,
    importOpen: false,
  });
});
afterEach(cleanup);

const sentFile = (call = 0): HostsFileWire => (saveHosts.mock.calls[call]?.[0] as { file: HostsFileWire }).file;

describe('identity helpers', () => {
  it('lists the entries naming an identity and the hosts signing in with it', () => {
    expect(identityReferences(FILE, 'deploy')).toEqual(['Production', 'beta']);
    expect(identityReferences(FILE, 'spare')).toEqual([]);
    expect(identityHosts(RESOLVED, 'deploy')).toEqual(['alpha', 'beta']);
  });
  it('removing an identity drops every reference and keeps the entries’ own settings', () => {
    const next = removeIdentity(FILE, 'deploy');
    expect(next.identities?.map((i) => i.id)).toEqual(['spare']);
    expect(next.groups[0]?.ssh).toEqual({});
    expect(next.hosts[0]?.ssh).toEqual({ user: 'root' });
  });
  it('upserts in place or appends, and finds a free id in the identities only', () => {
    const edited = upsertIdentity(FILE, { id: 'spare', name: 'Spare', user: 'other' });
    expect(edited.identities?.map((i) => i.user)).toEqual(['deploy', 'other']);
    expect(upsertIdentity(FILE, { id: 'new', name: 'New' }).identities).toHaveLength(3);
    expect(freeIdentityId(FILE, 'deploy')).toBe('deploy-2');
    expect(freeIdentityId(FILE, 'alpha')).toBe('alpha');
  });
  it('the form resolves user and auth as main does: own identity, then each group, value before identity', () => {
    const groups = FILE.groups;
    expect(inheritedLogin(FILE.identities, groups, undefined, 'user')).toEqual({
      value: 'deploy',
      from: { identity: 'Deploy' },
    });
    // The entry's own identity wins over the group's.
    expect(inheritedLogin(FILE.identities, groups, 'spare', 'user')).toEqual({
      value: 'spare',
      from: { identity: 'Spare' },
    });
    // Spare has no sign-in, so auth passes on to the group's identity.
    expect(inheritedLogin(FILE.identities, groups, 'spare', 'auth').from).toEqual({ identity: 'Deploy' });
    // A group's own value beats the identity it names.
    const own = groups.map((g) => ({ ...g, ssh: { identity: 'deploy', user: 'ops' } }));
    expect(inheritedLogin(FILE.identities, own, undefined, 'user')).toEqual({
      value: 'ops',
      from: { group: 'Production' },
    });
    expect(inheritedLogin(FILE.identities, [], undefined, 'user')).toEqual({ value: undefined, from: 'default' });
  });
  it('past every group and identity the form inherits Preferences → SSH, as main does (#571)', () => {
    const prefs = sshPreferenceDefaults({ user: 'alice', keepAlive: 60, connectTimeout: 45 });
    expect(inheritedLogin(FILE.identities, [], undefined, 'user', prefs)).toEqual({
      value: 'alice',
      from: 'preferences',
    });
    // An identity's user still wins over the default.
    expect(inheritedLogin(FILE.identities, FILE.groups, undefined, 'user', prefs).from).toEqual({
      identity: 'Deploy',
    });
    expect(inheritedLogin(FILE.identities, [], undefined, 'auth', prefs)).toEqual({
      value: undefined,
      from: 'default',
    });
    expect(inheritedFrom([], 'keepAlive', prefs)).toEqual({ value: 60, from: 'preferences' });
    expect(inheritedFrom([], 'connectTimeout', prefs)).toEqual({ value: 45, from: 'preferences' });
    expect(inheritedFrom([], 'port', prefs)).toEqual({ value: 22, from: 'default' });
    const group = FILE.groups.map((g) => ({ ...g, ssh: { keepAlive: 5 } }));
    expect(inheritedFrom(group, 'keepAlive', prefs)).toEqual({ value: 5, from: { group: 'Production' } });
    expect(sshPreferenceDefaults({ user: '  ', keepAlive: 15, connectTimeout: 20 }).user).toBeUndefined();
    expect(sourceText({ value: 'alice', from: 'preferences' })).toBe('alice · from Preferences');
  });
});

describe('host form: Identity', () => {
  it('picking an identity hands it the user and sign-in, and saves only its id', async () => {
    useHostsStore.setState({ dialog: { mode: 'new-host' } });
    render(<HostDialog />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    });
    await userEvent.type(screen.getByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'gamma.example');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Identity' }), 'deploy');
    expect(screen.getByText('deploy · from identity Deploy')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('User').disabled).toBe(true);
    expect(screen.getByText('Inherited: key (DEPLOY_KEY) (from identity Deploy)')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setSecret).not.toHaveBeenCalled();
    expect(sentFile().hosts.at(-1)?.ssh).toEqual({ identity: 'deploy' });
  });
  it('a group’s identity shows as the source, and the select offers Inherit', async () => {
    useHostsStore.setState({ dialog: { mode: 'new-host', parent: 'g' } });
    render(<HostDialog />);
    const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Identity' });
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: 'Inherit' })).toBeDefined();
    expect(screen.getByText('Deploy · from Production')).toBeDefined();
    expect(screen.getByText('deploy · from identity Deploy')).toBeDefined();
  });
  it('is not shown while the file has no identities', async () => {
    useHostsStore.setState({ file: { ...FILE, identities: [], groups: [], hosts: [] }, dialog: { mode: 'new-host' } });
    render(<HostDialog />);
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('combobox', { name: 'Identity' })).toBeNull();
  });
  it('Save as host… from a one-off server saves it as typed, signed in with the agent (#537)', async () => {
    useHostsStore.setState({
      file: { ...FILE, identities: [], groups: [], hosts: [] },
      dialog: { mode: 'new-host', prefill: { name: 'db.example', address: 'db.example', port: 2222, user: 'ops' } },
    });
    render(<HostDialog />);
    expect((await screen.findByLabelText<HTMLInputElement>('Name')).value).toBe('db.example');
    expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('ops');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentFile().hosts.at(-1)).toMatchObject({
      name: 'db.example',
      address: 'db.example',
      ssh: { user: 'ops', port: 2222, auth: { kind: 'agent' } },
    });
  });
});

describe('Keychain: identities', () => {
  it('lists each identity with its user, sign-in and the hosts that use it', async () => {
    render(<SshHome />);
    const row = await screen.findByTestId('identity-row-deploy');
    expect(row.textContent).toContain('Deploy');
    expect(row.textContent).toContain('deploy · key DEPLOY_KEY');
    expect(row.textContent).toContain('Used by alpha, beta');
    expect(screen.getByTestId('identity-row-spare').textContent).toContain('Not used by any host');
  });
  it('editing one saves it once, for every host that uses it', async () => {
    render(<SshHome />);
    const row = await screen.findByTestId('identity-row-deploy');
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit identity Deploy' });
    const user = within(form).getByLabelText('User');
    await userEvent.clear(user);
    await userEvent.type(user, 'release');
    await userEvent.click(within(form).getByRole('button', { name: 'Update identity' }));
    expect(saveHosts).toHaveBeenCalledTimes(1);
    expect(sentFile().identities?.[0]).toEqual({
      id: 'deploy',
      name: 'Deploy',
      user: 'release',
      auth: { kind: 'key', secret: 'DEPLOY_KEY' },
    });
    expect(sentFile().hosts).toEqual(FILE.hosts);
  });
  it('a new identity stores its typed password as a secret and writes only the name', async () => {
    render(<SshHome />);
    await userEvent.click(await screen.findByRole('button', { name: /New identity/ }));
    const form = screen.getByRole('form', { name: 'New identity' });
    await userEvent.type(within(form).getByLabelText('Identity name'), 'Ops admin');
    await userEvent.type(within(form).getByLabelText('User'), 'admin');
    await userEvent.type(within(form).getByLabelText('Password', { selector: 'input[type="password"]' }), 'pw');
    await userEvent.click(within(form).getByRole('button', { name: 'Add identity' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'ops_admin_password', value: 'pw' });
    expect(sentFile().identities?.at(-1)).toEqual({
      id: 'ops-admin',
      name: 'Ops admin',
      user: 'admin',
      auth: { kind: 'password', secret: 'ops_admin_password' },
    });
    expect(JSON.stringify(sentFile())).not.toContain('"pw"');
  });
  it('deleting one in use asks first, then drops it and its references', async () => {
    render(<SshHome />);
    const row = await screen.findByTestId('identity-row-deploy');
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByTestId('identity-delete-dialog');
    expect(dialog.textContent).toContain('Production, beta use it');
    expect(saveHosts).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete identity' }));
    await vi.waitFor(() => {
      expect(saveHosts).toHaveBeenCalledTimes(1);
    });
    expect(sentFile().identities?.map((i) => i.id)).toEqual(['spare']);
    expect(sentFile().hosts[0]?.ssh).toEqual({ user: 'root' });
  });
  it('deleting one nothing names does not ask', async () => {
    render(<SshHome />);
    const row = await screen.findByTestId('identity-row-spare');
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => {
      expect(saveHosts).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('identity-delete-dialog')).toBeNull();
    expect(sentFile().identities?.map((i) => i.id)).toEqual(['deploy']);
  });
});
