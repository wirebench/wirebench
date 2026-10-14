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
import { AgentForwardingMark, agentForwardingOf } from '../../src/renderer/features/ssh/agent-forwarding.js';
import { HostDetails, sshCommandOf } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'ops',
      name: 'Ops',
      tags: [],
      ssh: { user: 'ops', auth: { kind: 'agent' }, forwardAgent: true },
      groups: [],
      hosts: [{ id: 'git-box', name: 'git-box', address: '10.0.0.5', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'plain', name: 'plain', address: '10.0.0.1', tags: [], ssh: { user: 'u', auth: { kind: 'agent' } } }],
};

const resolvedHost = (
  id: string,
  address: string,
  forwardAgent: ResolvedHostWire['ssh']['forwardAgent'],
): ResolvedHostWire => ({
  id,
  name: id,
  address,
  tags: [],
  path: [],
  protected: { value: false, from: 'default' },
  ssh: {
    user: { value: 'ops', from: 'host' },
    port: { value: 22, from: 'default' },
    auth: { value: { kind: 'agent' }, from: 'host' },
    jump: { value: undefined, from: 'default' },
    keepAlive: { value: 15, from: 'default' },
    connectTimeout: { value: 20, from: 'default' },
    forwardAgent,
  },
  forwards: [],
  env: [],
});

const RESOLVED: ResolvedHostWire[] = [
  resolvedHost('git-box', '10.0.0.5', { value: true, from: { group: 'ops' } }),
  resolvedHost('plain', '10.0.0.1', { value: false, from: 'default' }),
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
const section = () => screen.getByRole('region', { name: 'Agent forwarding' });
const toggle = () => within(section()).getByRole<HTMLButtonElement>('switch', { name: 'Forward SSH agent' });
const inherit = () => within(section()).getByRole('button', { name: 'Inherit Forward SSH agent' });
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('the agent forwarding section of the host form', () => {
  it('is off by default, with no warning', () => {
    edit('plain');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(within(section()).getByText('off · default')).toBeTruthy();
    expect(within(section()).queryByRole('note')).toBeNull();
  });

  it('shows the inherited value with its group, and the warning while it is on', () => {
    edit('git-box');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(within(section()).getByText('on · from Ops')).toBeTruthy();
    expect(within(section()).queryByRole('button', { name: 'Inherit Forward SSH agent' })).toBeNull();
    expect(within(section()).getByRole('note').textContent).toMatch(/root on this host can use the keys/);
  });

  it('turning it on here saves forwardAgent: true on the host and shows the warning', async () => {
    edit('plain');
    await userEvent.click(toggle());
    expect(within(section()).getByRole('note')).toBeTruthy();
    await save();
    expect(saved().hosts[0]!.ssh.forwardAgent).toBe(true);
  });

  it('a host can switch an inherited forward off; a host that inherits writes no key', async () => {
    edit('git-box');
    await userEvent.click(toggle());
    expect(within(section()).queryByRole('note')).toBeNull();
    // Inherit takes the group's value back; flipping again pins it off here.
    await userEvent.click(inherit());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle());
    await save();
    expect(saved().groups[0]!.hosts[0]!.ssh.forwardAgent).toBe(false);
    cleanup();
    edit('plain');
    await save();
    expect(saved().hosts[0]!.ssh).not.toHaveProperty('forwardAgent');
  });
});

describe('host details', () => {
  it('lists agent forwarding with its source, and the command carries -A', () => {
    useHostsStore.setState({ selectedHostId: 'git-box', detailsOpen: true });
    render(<HostDetails />);
    const row = screen.getByText('Agent forwarding').parentElement!;
    expect(row.textContent).toContain('On');
    expect(row.textContent).toContain('from Ops');
    expect(sshCommandOf(RESOLVED[0]!, undefined)).toBe('ssh -A ops@10.0.0.5');
    expect(sshCommandOf(RESOLVED[1]!, undefined)).toBe('ssh ops@10.0.0.1');
  });
});

describe('the forwarding mark on a terminal', () => {
  it('sums up a tab: on wins, then a reason it is not forwarded, else nothing', () => {
    const panes = {
      p1: { hostId: 'a', state: 'open' as const, agentForwarding: 'refused' as const },
      p2: { hostId: 'b', state: 'open' as const, agentForwarding: 'on' as const },
      p3: { hostId: 'c', state: 'open' as const },
      p4: { hostId: 'd', state: 'closed' as const, agentForwarding: 'on' as const },
    };
    expect(agentForwardingOf(panes, ['p1', 'p2'])).toBe('on');
    expect(agentForwardingOf(panes, ['p1', 'p3'])).toBe('refused');
    expect(agentForwardingOf(panes, ['p3', 'p4'])).toBeUndefined();
  });

  it('names its state for screen readers', () => {
    render(
      <>
        <AgentForwardingMark state="on" />
        <AgentForwardingMark state="refused" />
        <AgentForwardingMark state="no-agent" />
      </>,
    );
    expect(screen.getByRole('img', { name: 'SSH agent forwarded' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'SSH agent not forwarded: the server refused it' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'SSH agent not forwarded: no local agent is running' })).toBeTruthy();
  });
});
