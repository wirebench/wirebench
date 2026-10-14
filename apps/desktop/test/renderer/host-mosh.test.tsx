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
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, setHostOs, secretNames, knownHosts, keys } }),
}));
import { connectErrorKind, connectFailureSentence } from '../../src/renderer/features/ssh/connect-errors.js';
import { HostDetails } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { cleanMosh, moshProblem, validMoshPorts } from '../../src/renderer/features/ssh/mosh-section.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'roam',
      name: 'Roaming',
      tags: [],
      ssh: { user: 'ops', auth: { kind: 'agent' }, protocol: 'mosh', mosh: { ports: '60000:60010' } },
      groups: [],
      hosts: [{ id: 'train', name: 'train', address: '10.0.0.5', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'plain', name: 'plain', address: '10.0.0.1', tags: [], ssh: { user: 'u', auth: { kind: 'agent' } } }],
};

const resolvedHost = (id: string, address: string, mosh: boolean): ResolvedHostWire => ({
  id,
  name: id,
  address,
  tags: [],
  path: mosh ? ['roam'] : [],
  protected: { value: false, from: 'default' },
  ssh: {
    user: { value: 'ops', from: 'host' },
    port: { value: 22, from: 'default' },
    auth: { value: { kind: 'agent' }, from: 'host' },
    jump: { value: undefined, from: 'default' },
    keepAlive: { value: 15, from: 'default' },
    connectTimeout: { value: 20, from: 'default' },
    forwardAgent: { value: false, from: 'default' },
    ...(mosh
      ? {
          protocol: { value: 'mosh' as const, from: { group: 'roam' } },
          mosh: { value: { ports: '60000:60010' }, from: { group: 'roam' } },
        }
      : {}),
  },
  forwards: [],
  env: [],
});

const RESOLVED: ResolvedHostWire[] = [
  resolvedHost('train', '10.0.0.5', true),
  resolvedHost('plain', '10.0.0.1', false),
];
const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;

beforeEach(() => {
  vi.clearAllMocks();
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve({ ok: true, value: { file, resolved: RESOLVED, problems: [] } }),
  );
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

describe('the protocol section of the host form (#419)', () => {
  it('is SSH by default, with no Mosh fields', () => {
    edit('plain');
    expect(select().value).toBe('');
    expect(within(section()).getByRole('option', { name: 'SSH' })).toBeTruthy();
    expect(within(section()).queryByLabelText('UDP ports')).toBeNull();
  });

  it('choosing Mosh shows the server fields and saves protocol and block on the host', async () => {
    edit('plain');
    await userEvent.selectOptions(select(), 'mosh');
    expect(within(section()).getByRole('note').textContent).toMatch(/mosh-client/);
    await userEvent.type(within(section()).getByLabelText('Server command'), '/opt/mosh-server');
    await userEvent.type(within(section()).getByLabelText('UDP ports'), '61000:61005');
    await save();
    expect(saved().hosts[0]!.ssh).toMatchObject({
      protocol: 'mosh',
      mosh: { server: '/opt/mosh-server', ports: '61000:61005' },
    });
  });

  it('shows what a group sets, and a host inheriting it writes nothing', async () => {
    edit('train');
    expect(select().value).toBe('');
    expect(within(section()).getByRole('option', { name: 'Inherit (Mosh)' })).toBeTruthy();
    expect(within(section()).getByText('Mosh · from Roaming')).toBeTruthy();
    expect(within(section()).getByLabelText<HTMLInputElement>('UDP ports').placeholder).toBe('60000:60010');
    await save();
    const ssh = saved().groups[0]!.hosts[0]!.ssh;
    expect(ssh.protocol).toBeUndefined();
    expect(ssh.mosh).toBeUndefined();
  });

  it('a host can switch an inherited Mosh back to SSH', async () => {
    edit('train');
    await userEvent.selectOptions(select(), 'ssh');
    expect(within(section()).queryByLabelText('UDP ports')).toBeNull();
    await save();
    expect(saved().groups[0]!.hosts[0]!.ssh.protocol).toBe('ssh');
  });

  it('holds Save while the port range is not valid', async () => {
    edit('plain');
    await userEvent.selectOptions(select(), 'mosh');
    await userEvent.type(within(section()).getByLabelText('UDP ports'), '9:1');
    expect(within(section()).getByRole('alert').textContent).toMatch(/LOW:HIGH/);
    expect(screen.getByRole('list', { name: 'Needed to save' }).textContent).toMatch(/UDP ports/);
  });
});

describe('Mosh helpers', () => {
  it('check ports the way hosts.yaml does', () => {
    expect(validMoshPorts('60001')).toBe(true);
    expect(validMoshPorts('60000:60010')).toBe(true);
    for (const bad of ['', '0', '65536', '2:1', '1-2']) expect(validMoshPorts(bad)).toBe(false);
    expect(moshProblem({ ports: '2:1' })).toMatch(/UDP ports/);
    expect(moshProblem({ ports: '1:2' })).toBeUndefined();
  });
  it('drop a block whose fields are all empty', () => {
    expect(cleanMosh({ server: '  ', ports: '' })).toBeUndefined();
    expect(cleanMosh({ server: ' x ' })).toEqual({ server: 'x' });
  });
});

describe('host details', () => {
  it('shows the protocol with where it comes from', () => {
    useHostsStore.setState({ selectedHostId: 'train', detailsOpen: true });
    render(<HostDetails />);
    const row = screen.getByText('Protocol').parentElement!;
    expect(row.textContent).toContain('Mosh');
    expect(row.textContent).toContain('from Roaming');
  });
});

describe('connect errors', () => {
  it('say what to do for each Mosh refusal', () => {
    const sentence = (code: string, details: Record<string, unknown> = {}) =>
      connectFailureSentence({ code, message: '', details }, 'terminal');
    expect(sentence('mosh-server-missing', { host: 'h:22', server: 'mosh-server' })).toMatch(
      /mosh-server was not found on h:22\. Install mosh on the server/,
    );
    expect(sentence('mosh-bootstrap-failed', { host: 'h:22', serverSaid: 'bad locale' })).toMatch(
      /mosh server on h:22 did not start: bad locale/,
    );
    expect(sentence('mosh-bootstrap-failed', { host: 'h:22', timedOut: true })).toMatch(/did not answer in time/);
    expect(sentence('mosh-client-missing')).toMatch(/Install mosh/);
    expect(sentence('mosh-unreachable', { host: 'box.lan' })).toMatch(/box\.lan.*UDP/);
    expect(connectErrorKind('mosh-client-missing')).toBe('settings');
    expect(connectErrorKind('mosh-server-missing')).toBe('settings');
    expect(connectErrorKind('mosh-unreachable')).toBe('network');
  });
});
