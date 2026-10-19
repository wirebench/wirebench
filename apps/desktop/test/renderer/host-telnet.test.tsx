import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const setHostOs = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const secretNames = vi.fn(() => Promise.resolve({ ok: true, value: { names: [] } }));
const knownHosts = vi.fn(() => Promise.resolve({ ok: true, value: { entries: [] } }));
const keys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
const localUser = vi.fn(() => Promise.resolve({ ok: true, value: { name: 'me' } }));
const setSecret = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, setHostOs, secretNames, knownHosts, keys, localUser, setSecret } }),
}));
import { connectErrorKind, connectFailureSentence } from '../../src/renderer/features/ssh/connect-errors.js';
import { HostDetails } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { HostActionsButton } from '../../src/renderer/features/ssh/host-menus.js';
import { telnetTargetText } from '../../src/renderer/features/ssh/host-protocol.js';
import { HostCards } from '../../src/renderer/features/ssh/host-cards.js';
import { DEFAULT_HOSTS_PREFS } from '../../src/renderer/features/ssh/hosts-prefs.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'switches',
      name: 'Switches',
      tags: [],
      ssh: { protocol: 'telnet' },
      groups: [],
      hosts: [{ id: 'core', name: 'core', address: '10.0.0.2', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'plain', name: 'plain', address: '10.0.0.1', tags: [], ssh: { user: 'u', auth: { kind: 'agent' } } }],
};

const resolvedHost = (id: string, address: string, telnet: boolean): ResolvedHostWire => ({
  id,
  name: id,
  address,
  tags: [],
  path: telnet ? ['switches'] : [],
  protected: { value: false, from: 'default' },
  ssh: {
    user: telnet ? { value: undefined, from: 'default' } : { value: 'u', from: 'host' },
    port: { value: telnet ? 23 : 22, from: 'default' },
    auth: telnet ? { value: undefined, from: 'default' } : { value: { kind: 'agent' }, from: 'host' },
    jump: { value: undefined, from: 'default' },
    keepAlive: { value: 15, from: 'default' },
    connectTimeout: { value: 20, from: 'default' },
    forwardAgent: { value: false, from: 'default' },
    proxy: { value: undefined, from: 'default' },
    protocol: telnet ? { value: 'telnet', from: { group: 'switches' } } : { value: 'ssh', from: 'default' },
    mosh: { value: undefined, from: 'default' },
  },
  forwards: [],
  env: [],
});

const RESOLVED: ResolvedHostWire[] = [resolvedHost('core', '10.0.0.2', true), resolvedHost('plain', '10.0.0.1', false)];
const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;

beforeEach(() => {
  vi.clearAllMocks();
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve({ ok: true, value: { file, resolved: RESOLVED, problems: [] } }),
  );
  useUiStore.setState({ telnetEnabled: true });
  useHostsStore.setState({
    file: FILE,
    resolved: RESOLVED,
    problems: [],
    loaded: true,
    dialog: null,
    osByHost: {},
    homeView: 'hosts',
    panes: {},
  });
});
afterEach(() => {
  cleanup();
});

const edit = (id: string) => render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id }} embedded />);
const section = () => screen.getByRole('region', { name: 'Protocol' });
const select = () => within(section()).getByRole<HTMLSelectElement>('combobox', { name: 'Protocol' });
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('Telnet in the host form (#425)', () => {
  it('choosing Telnet warns that it is not encrypted, drops SSH-only settings and saves the protocol', async () => {
    edit('plain');
    expect(screen.getByLabelText('Keep-alive (s)')).toBeTruthy();
    await userEvent.selectOptions(select(), 'telnet');
    expect(within(section()).getByRole('note').textContent).toMatch(/not encrypted/);
    expect(screen.queryByLabelText('Keep-alive (s)')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Port forwarding' })).toBeNull();
    // A password is the only way a Telnet host signs in; the agent stays shown while it is the choice.
    const auth = screen.getByRole('radiogroup', { name: 'Authentication' });
    expect(within(auth).queryByLabelText('Key')).toBeNull();
    expect(within(auth).getByLabelText('Password')).toBeTruthy();
    await save();
    expect(saved().hosts[0]!.ssh.protocol).toBe('telnet');
  });

  it('a host in a Telnet group inherits it, with port 23, and needs no user or password', async () => {
    edit('core');
    expect(within(section()).getByRole('option', { name: 'Inherit (Telnet)' })).toBeTruthy();
    expect(screen.getByText(/types the user and password at the device's/)).toBeTruthy();
    // The note sits right under the sign-in choice it explains; Group comes after it (S61).
    const note = screen.getByTestId('host-telnet-sign-in-note');
    const auth = screen.getByRole('radiogroup', { name: 'Authentication' });
    const group = screen.getByLabelText('Group');
    expect(auth.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Port').placeholder).toBe('23');
    await save();
    expect(saved().groups[0]!.hosts[0]!.ssh).toEqual({});
  });

  it('a new host in a Telnet group starts with no user and no password to fill in', async () => {
    render(<HostForm file={FILE} dialog={{ mode: 'new-host', parent: 'switches' }} embedded />);
    await userEvent.type(screen.getByLabelText('Name'), 'edge');
    await userEvent.type(screen.getByLabelText('Address'), '10.0.0.3');
    await save();
    const host = saved().groups[0]!.hosts.find((h) => h.name === 'edge')!;
    expect(host.ssh.user).toBeUndefined();
    expect(host.ssh.auth).toBeUndefined();
  });

  it('a password typed before choosing Telnet is kept', async () => {
    render(<HostForm file={FILE} dialog={{ mode: 'new-host' }} embedded />);
    await userEvent.type(screen.getByLabelText('Name'), 'edge');
    await userEvent.type(screen.getByLabelText('Address'), '10.0.0.3');
    await userEvent.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'pw');
    await userEvent.click(screen.getByText('Advanced'));
    await userEvent.selectOptions(select(), 'telnet');
    await save();
    expect(setSecret).toHaveBeenCalled();
    expect(saved().hosts.find((h) => h.name === 'edge')!.ssh.auth).toMatchObject({ kind: 'password' });
  });

  it('is not offered when this build switched Telnet off, and says so on a host set to it', () => {
    useUiStore.setState({ telnetEnabled: false });
    edit('plain');
    expect(within(section()).queryByRole('option', { name: 'Telnet' })).toBeNull();
    cleanup();
    render(
      <HostForm
        file={{ ...FILE, hosts: [{ ...FILE.hosts[0]!, ssh: { protocol: 'telnet' } }] }}
        dialog={{ mode: 'edit-host', id: 'plain' }}
        embedded
      />,
    );
    expect(within(section()).getByRole('option', { name: 'Telnet (switched off)' })).toBeTruthy();
    expect(within(section()).getByRole('note').textContent).toMatch(/switched off/);
  });
});

describe('a Telnet host elsewhere (#425)', () => {
  it('details show the protocol and no encryption, and leave out Files, the agent, host key and command', () => {
    useHostsStore.setState({ selectedHostId: 'core' });
    render(<HostDetails />);
    const row = screen.getByText('Protocol').parentElement!;
    expect(row.textContent).toContain('Telnet');
    expect(row.textContent).toContain('from Switches');
    expect(screen.getByText('Encryption').parentElement!.textContent).toMatch(/plain text/);
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
    expect(screen.queryByText('Agent forwarding')).toBeNull();
    expect(screen.queryByText('Host key')).toBeNull();
    expect(screen.queryByText('Command')).toBeNull();
  });

  it('the host menu offers no Open files or Install public key', async () => {
    render(<HostActionsButton host={FILE.groups[0]!.hosts[0]!} />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: 'Connect' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open files' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Install public key…' })).toBeNull();
  });

  it('connect errors say what to do', () => {
    const sentence = (code: string) => connectFailureSentence({ code, message: '', details: {} }, 'terminal');
    expect(sentence('telnet-off')).toMatch(/switched off/);
    expect(sentence('ssh-jump-not-ssh')).toMatch(/must be reached over SSH/);
    expect(sentence('ssh-protocol-unsupported')).toMatch(/need SSH/);
    for (const code of ['telnet-off', 'ssh-jump-not-ssh', 'ssh-protocol-unsupported']) {
      expect(connectErrorKind(code)).toBe('settings');
    }
  });
});

describe('a Telnet host’s target says so (#688)', () => {
  it('reads "Telnet · user@address", the port only when it is not 23', () => {
    expect(telnetTargetText('10.1.1.1', 'admin', 23)).toBe('Telnet · admin@10.1.1.1');
    expect(telnetTargetText('10.1.1.1', undefined, undefined)).toBe('Telnet · 10.1.1.1');
    expect(telnetTargetText('10.1.1.1', 'admin', 2323)).toBe('Telnet · admin@10.1.1.1:2323');
  });

  it('a card shows the Telnet target with the not-encrypted mark; an SSH card shows neither', () => {
    render(<HostCards prefs={DEFAULT_HOSTS_PREFS} onPrefs={vi.fn()} />);
    const telnet = screen.getByTestId('host-row-core');
    expect(telnet.textContent).toContain('Telnet · 10.0.0.2');
    expect(within(telnet).getByRole('img', { name: 'Not encrypted' })).toBeTruthy();
    const ssh = screen.getByTestId('host-row-plain');
    expect(ssh.textContent).toContain('u@10.0.0.1');
    expect(ssh.textContent).not.toContain('Telnet');
    expect(within(ssh).queryByRole('img', { name: 'Not encrypted' })).toBeNull();
  });

  it('the draft card of a new Telnet host reads the same, without a bare :23', async () => {
    render(<HostForm file={FILE} dialog={{ mode: 'new-host', parent: 'switches' }} embedded />);
    await userEvent.type(screen.getByLabelText('Name'), 'edge');
    await userEvent.type(screen.getByLabelText('Address'), '10.1.1.1');
    await userEvent.type(screen.getByLabelText('User'), 'admin');
    expect(useHostsStore.getState().draft).toMatchObject({ target: 'Telnet · admin@10.1.1.1', plainText: true });
    cleanup();
    useHostsStore.setState({ dialog: { mode: 'new-host', parent: 'switches' } });
    render(<HostCards prefs={DEFAULT_HOSTS_PREFS} onPrefs={vi.fn()} />);
    const card = screen.getByTestId('host-draft-card');
    expect(card.textContent).toContain('Telnet · admin@10.1.1.1');
    expect(card.textContent).not.toContain(':23');
    expect(within(card).getByRole('img', { name: 'Not encrypted' })).toBeTruthy();
  });
});
