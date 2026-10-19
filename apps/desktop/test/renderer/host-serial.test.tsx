import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const serialPorts = vi.fn(() =>
  Promise.resolve({ ok: true, value: { ports: [{ path: '/dev/ttyUSB0', label: 'FTDI' }, { path: '/dev/ttyS0' }] } }),
);
const serialDevice = vi.fn<(request: { hostId: string }) => Promise<unknown>>(() =>
  Promise.resolve({ ok: true, value: {} }),
);
const setSerialDevice = vi.fn<(request: { hostId: string; device: string | null }) => Promise<unknown>>(() =>
  Promise.resolve({ ok: true, value: {} }),
);
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({
    ssh: {
      listHosts,
      saveHosts,
      setHostOs,
      secretNames,
      knownHosts,
      keys,
      localUser,
      setSecret,
      serialPorts,
      serialDevice,
      setSerialDevice,
    },
  }),
}));
import {
  connectErrorKind,
  connectFailureSentence,
  connectFix,
} from '../../src/renderer/features/ssh/connect-errors.js';
import { HostDetails } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { HostActionsButton } from '../../src/renderer/features/ssh/host-menus.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { logTarget } from '../../src/renderer/features/ssh/session-logs.js';
import { serialLabel } from '../../src/renderer/features/ssh/serial-section.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'lab',
      name: 'Lab',
      tags: [],
      ssh: { protocol: 'serial', serial: { baud: 9600 } },
      groups: [],
      hosts: [{ id: 'router', name: 'router', address: '', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'plain', name: 'plain', address: '10.0.0.1', tags: [], ssh: { user: 'u', auth: { kind: 'agent' } } }],
};

const resolvedHost = (id: string, serial: boolean): ResolvedHostWire => ({
  id,
  name: id,
  address: serial ? '' : '10.0.0.1',
  tags: [],
  path: serial ? ['lab'] : [],
  protected: { value: false, from: 'default' },
  ssh: {
    user: serial ? { value: undefined, from: 'default' } : { value: 'u', from: 'host' },
    port: { value: 22, from: 'default' },
    auth: serial ? { value: undefined, from: 'default' } : { value: { kind: 'agent' }, from: 'host' },
    jump: { value: undefined, from: 'default' },
    keepAlive: { value: 15, from: 'default' },
    connectTimeout: { value: 20, from: 'default' },
    forwardAgent: { value: false, from: 'default' },
    proxy: { value: undefined, from: 'default' },
    protocol: serial ? { value: 'serial', from: { group: 'lab' } } : { value: 'ssh', from: 'default' },
    mosh: { value: undefined, from: 'default' },
    serial: serial ? { value: { baud: 9600 }, from: { group: 'lab' } } : { value: undefined, from: 'default' },
  },
  forwards: [],
  env: [],
});

const RESOLVED: ResolvedHostWire[] = [resolvedHost('router', true), resolvedHost('plain', false)];
const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;

beforeEach(() => {
  vi.clearAllMocks();
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve({ ok: true, value: { file, resolved: RESOLVED, problems: [] } }),
  );
  useUiStore.setState({ telnetEnabled: true, serialEnabled: true });
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
const protocolSelect = () =>
  within(screen.getByRole('region', { name: 'Protocol' })).getByRole<HTMLSelectElement>('combobox', {
    name: 'Protocol',
  });
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('a serial console in the host form (#426)', () => {
  it('choosing it drops the network and sign-in fields, and saves the line and this computer’s device', async () => {
    edit('plain');
    expect(screen.getByLabelText('Address')).toBeTruthy();
    await userEvent.selectOptions(protocolSelect(), 'serial');
    expect(within(screen.getByRole('region', { name: 'Protocol' })).getByRole('note').textContent).toMatch(
      /serial port on this computer/,
    );
    for (const gone of ['Address', 'User', 'Port', 'Keep-alive (s)', 'Connect timeout (s)', 'Jump host', 'OS']) {
      expect(screen.queryByLabelText(gone), gone).toBeNull();
    }
    expect(screen.queryByRole('radiogroup', { name: 'Authentication' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Port forwarding' })).toBeNull();
    // This machine's ports are offered, the line starts at its defaults.
    await waitFor(() => {
      expect(screen.getByText(/Found: \/dev\/ttyUSB0 — FTDI, \/dev\/ttyS0/)).toBeTruthy();
    });
    // The fields say the line; no "Line:" summary repeats them for a host's own (S16).
    expect(screen.getByLabelText<HTMLInputElement>('Baud').value).toBe('115200');
    expect(screen.queryByText(/^Line: /)).toBeNull();
    await userEvent.type(screen.getByLabelText('Device on this computer'), '/dev/ttyUSB0');
    const baud = screen.getByLabelText('Baud');
    await userEvent.clear(baud);
    await userEvent.type(baud, '9600');
    await userEvent.selectOptions(screen.getByLabelText('Parity'), 'even');
    await userEvent.selectOptions(screen.getByLabelText('Flow control'), 'rtscts');
    await save();
    const host = saved().hosts[0]!;
    expect(host.ssh.protocol).toBe('serial');
    expect(host.ssh.serial).toEqual({ baud: 9600, parity: 'even', flowControl: 'rtscts' });
    expect(setSerialDevice).toHaveBeenCalledWith({ hostId: 'plain', device: '/dev/ttyUSB0' });
  });

  it('a console in a serial group inherits its line, needs no address, and keeps its device unchanged', async () => {
    serialDevice.mockResolvedValueOnce({ ok: true, value: { device: 'COM3' } });
    edit('router');
    expect(
      within(screen.getByRole('region', { name: 'Protocol' })).getByRole('option', {
        name: 'Inherit (Serial console)',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Line: 9600 8N1/).textContent).toMatch(/from Lab/);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Device on this computer').value).toBe('COM3');
    });
    await save();
    expect(saved().groups[0]!.hosts[0]!.ssh).toEqual({});
    expect(setSerialDevice).not.toHaveBeenCalled();
  });

  it('a new console starts with no user or sign-in and is saved without an address', async () => {
    render(<HostForm file={FILE} dialog={{ mode: 'new-host', parent: 'lab' }} embedded />);
    await userEvent.type(screen.getByLabelText('Name'), 'switch console');
    expect(screen.queryByLabelText('Address')).toBeNull();
    await save();
    const host = saved().groups[0]!.hosts.find((h) => h.name === 'switch console')!;
    expect(host.address).toBe('');
    expect(host.ssh.user).toBeUndefined();
    expect(host.ssh.auth).toBeUndefined();
    expect(setSerialDevice).not.toHaveBeenCalled();
  });

  it('a baud that is not a whole number holds Save', async () => {
    edit('router');
    const baud = screen.getByLabelText('Baud');
    await userEvent.clear(baud);
    await userEvent.type(baud, '96.5');
    expect(screen.getByRole('alert').textContent).toMatch(/whole number/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('is not offered when this build switched serial consoles off, and says so on a host set to it', () => {
    useUiStore.setState({ serialEnabled: false });
    edit('plain');
    expect(
      within(screen.getByRole('region', { name: 'Protocol' })).queryByRole('option', { name: 'Serial console' }),
    ).toBeNull();
    cleanup();
    render(
      <HostForm
        file={{ ...FILE, hosts: [{ ...FILE.hosts[0]!, ssh: { protocol: 'serial' } }] }}
        dialog={{ mode: 'edit-host', id: 'plain' }}
        embedded
      />,
    );
    const section = screen.getByRole('region', { name: 'Protocol' });
    expect(within(section).getByRole('option', { name: 'Serial console (switched off)' })).toBeTruthy();
    expect(within(section).getByRole('note').textContent).toMatch(/switched off/);
  });
});

describe('a serial console elsewhere (#426)', () => {
  it('details show the device and the line, and no address, sign-in, timing, Files or command', async () => {
    serialDevice.mockResolvedValue({ ok: true, value: { device: '/dev/ttyUSB0' } });
    useHostsStore.setState({ selectedHostId: 'router' });
    render(<HostDetails />);
    await waitFor(() => {
      expect(screen.getByText('Device').parentElement!.textContent).toContain('/dev/ttyUSB0');
    });
    expect(screen.getByText('Line').parentElement!.textContent).toMatch(/9600 8N1.*from Lab/);
    expect(screen.getByText('Protocol').parentElement!.textContent).toContain('Serial console');
    for (const gone of ['Address', 'Port', 'User', 'Jump host', 'Proxy', 'Keep-alive', 'Host key', 'Command']) {
      expect(screen.queryByText(gone), gone).toBeNull();
    }
    expect(screen.queryByRole('region', { name: 'Sign-in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
    serialDevice.mockReset();
  });

  it('the host menu offers no Copy address, Open files or Install public key', async () => {
    render(<HostActionsButton host={FILE.groups[0]!.hosts[0]!} />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: 'Connect' })).toBeTruthy();
    for (const gone of ['Copy address', 'Open files', 'Install public key…']) {
      expect(screen.queryByRole('menuitem', { name: gone }), gone).toBeNull();
    }
  });

  it('connect errors say what to do, and an unset or missing device asks for one on the screen', () => {
    const error = (code: string, details: Record<string, unknown> = {}) => ({ code, message: '', details });
    const sentence = (code: string, details?: Record<string, unknown>) =>
      connectFailureSentence(error(code, details), 'terminal');
    expect(sentence('serial-device-unset')).toMatch(/Pick the serial port/);
    expect(sentence('serial-device-missing', { device: 'COM3' })).toMatch(/^COM3 is not on this computer/);
    expect(sentence('serial-device-busy', { device: 'COM3' })).toMatch(/in use by another program/);
    expect(sentence('serial-permission', { device: '/dev/ttyUSB0' })).toMatch(/dialout/);
    expect(sentence('serial-off')).toMatch(/switched off/);
    expect(sentence('ssh-protocol-unsupported', { protocol: 'serial' })).toMatch(/a serial console: files/);
    expect(sentence('ssh-jump-not-ssh', { protocol: 'serial' })).toMatch(/jump host is a serial console/);
    expect(connectFix(error('serial-device-unset'), undefined)).toMatchObject({ ask: 'device', retryPrimary: false });
    expect(connectFix(error('serial-device-missing'), undefined)).toMatchObject({ ask: 'device' });
    // A port another program holds frees up: Retry stays the main button.
    expect(connectFix(error('serial-device-busy'), undefined)).toEqual({ kind: 'other', retryPrimary: true });
    expect(connectErrorKind('serial-permission')).toBe('settings');
  });

  it('labels the line and a log by its device', () => {
    expect(serialLabel(undefined)).toBe('115200 8N1');
    expect(serialLabel({ baud: 9600, dataBits: 7, parity: 'odd', stopBits: 2, flowControl: 'xonxoff' })).toBe(
      '9600 7O2 · XON/XOFF',
    );
    expect(logTarget({ user: '', address: '/dev/ttyUSB0', port: 0 })).toBe('/dev/ttyUSB0');
    expect(logTarget({ user: 'admin', address: '10.0.0.2', port: 23 })).toBe('admin@10.0.0.2:23');
  });
});
