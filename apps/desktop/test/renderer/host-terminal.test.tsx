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
import { HostDetails } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { inheritedTerminal } from '../../src/renderer/features/ssh/host-terminal-section.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'prod',
      name: 'Production',
      tags: [],
      ssh: {},
      terminal: { scheme: 'red', fontSize: 15 },
      groups: [
        {
          id: 'eu',
          name: 'EU',
          tags: [],
          ssh: {},
          terminal: { fontSize: 16 },
          groups: [],
          hosts: [{ id: 'db-1', name: 'db-1', address: '10.0.1.7', tags: [], ssh: {} }],
        },
      ],
      hosts: [],
    },
  ],
  hosts: [{ id: 'lone', name: 'lone', address: '10.9.9.9', tags: [], ssh: {}, terminal: { scheme: 'nord' } }],
};

const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;
const savedDb1 = () => saved().groups[0]!.groups[0]!.hosts[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve({ ok: true, value: { file, resolved: [], problems: [] } }),
  );
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
  useHostsStore.setState({
    file: FILE,
    resolved: [],
    problems: [],
    loaded: true,
    dialog: { mode: 'edit-host', id: 'db-1' },
    osByHost: {},
    homeView: 'hosts',
  });
});
afterEach(() => {
  cleanup();
});

const edit = (id: string) => render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id }} embedded />);
const section = () => screen.getByRole('region', { name: 'Terminal' });
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('inheritedTerminal', () => {
  it('takes each field from the nearest group that sets it, else Preferences', () => {
    const prod = FILE.groups[0]!;
    expect(inheritedTerminal([prod, prod.groups[0]!], DEFAULT_PREFERENCES_WIRE.terminal)).toEqual({
      scheme: { value: 'red', from: { group: 'Production' } },
      fontSize: { value: 16, from: { group: 'EU' } },
    });
    expect(inheritedTerminal([], { ...DEFAULT_PREFERENCES_WIRE.terminal, colorScheme: 'nord' })).toEqual({
      scheme: { value: 'nord', from: { group: 'Preferences' } },
      fontSize: { value: 13, from: { group: 'Preferences' } },
    });
  });
});

describe('the terminal section of the host form', () => {
  it('shows the inherited scheme and size with their source', () => {
    edit('db-1');
    const scheme = within(section()).getByLabelText<HTMLSelectElement>('Colour scheme');
    expect(scheme.value).toBe('');
    expect(scheme.selectedOptions[0]?.textContent).toBe('Inherit: Red background, from Production');
    const size = within(section()).getByLabelText<HTMLInputElement>('Font size');
    expect(size.value).toBe('16');
    expect(size.disabled).toBe(true);
    expect(section().textContent).toContain('from EU');
  });

  it('sets a scheme and a size here; saving writes them, and inheriting again drops the key', async () => {
    edit('db-1');
    await userEvent.selectOptions(within(section()).getByLabelText('Colour scheme'), 'green');
    await userEvent.click(within(section()).getByRole('switch', { name: 'Override Font size' }));
    const size = within(section()).getByLabelText('Font size');
    await userEvent.clear(size);
    await userEvent.type(size, '18');
    await save();
    expect(savedDb1().terminal).toEqual({ scheme: 'green', fontSize: 18 });

    cleanup();
    edit('lone');
    await userEvent.selectOptions(within(section()).getByLabelText('Colour scheme'), '');
    await save();
    expect(saved().hosts[0]).not.toHaveProperty('terminal');
  });

  it('Save waits for a size in range', async () => {
    edit('db-1');
    await userEvent.click(within(section()).getByRole('switch', { name: 'Override Font size' }));
    const size = within(section()).getByLabelText('Font size');
    await userEvent.clear(size);
    await userEvent.type(size, '200');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    expect(within(section()).getByRole('alert').textContent).toContain('from 6 to 72');
  });
});

describe('the terminal in host details', () => {
  const host: ResolvedHostWire = {
    id: 'db-1',
    name: 'db-1',
    address: '10.0.1.7',
    tags: [],
    path: ['prod', 'eu'],
    protected: { value: false, from: 'default' },
    ssh: {
      user: { value: undefined, from: 'default' },
      port: { value: 22, from: 'default' },
      auth: { value: undefined, from: 'default' },
      jump: { value: undefined, from: 'default' },
      keepAlive: { value: 15, from: 'default' },
      connectTimeout: { value: 20, from: 'default' },
      forwardAgent: { value: false, from: 'default' },
      proxy: { value: undefined, from: 'default' },
    },
    forwards: [],
    env: [],
    terminal: {
      scheme: { value: 'red', from: { group: 'prod' } },
      fontSize: { value: 18, from: 'host' },
    },
  };

  it('shows the scheme and size with their source', () => {
    useHostsStore.setState({ resolved: [host], selectedHostId: 'db-1', detailsOpen: true, dialog: null });
    render(<HostDetails />);
    const terminal = screen.getByRole('region', { name: 'Terminal' });
    expect(terminal.textContent).toContain('SchemeRed backgroundfrom Production');
    expect(terminal.textContent).toContain('Font size18 pxset on host');
  });

  it('shows no Terminal section when the host takes both from Preferences', () => {
    useHostsStore.setState({
      resolved: [
        {
          ...host,
          terminal: { scheme: { value: undefined, from: 'default' }, fontSize: { value: undefined, from: 'default' } },
        },
      ],
      selectedHostId: 'db-1',
      detailsOpen: true,
      dialog: null,
    });
    render(<HostDetails />);
    expect(screen.queryByRole('region', { name: 'Terminal' })).toBeNull();
  });
});
