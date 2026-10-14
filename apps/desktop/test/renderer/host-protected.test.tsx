import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const secretNames = vi.fn(() => Promise.resolve({ ok: true, value: { names: [] } }));
const knownHosts = vi.fn(() => Promise.resolve({ ok: true, value: { entries: [] } }));
const setHostOs = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const keys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, secretNames, knownHosts, setHostOs, keys } }),
}));
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { HostDetails } from '../../src/renderer/features/ssh/host-details.js';
import { InheritedSwitch } from '../../src/renderer/features/ssh/inherited-field.js';
import { SshHome } from '../../src/renderer/features/ssh/ssh-home.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'prod',
      name: 'Production',
      tags: [],
      protected: true,
      ssh: {},
      groups: [],
      hosts: [{ id: 'api', name: 'api-1', address: '10.0.0.1', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'dev', name: 'dev-1', address: '10.0.0.2', tags: [], ssh: {} }],
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
const RESOLVED: ResolvedHostWire[] = [
  {
    id: 'api',
    name: 'api-1',
    address: '10.0.0.1',
    tags: [],
    path: ['prod'],
    protected: { value: true, from: { group: 'prod' } },
    ssh: defaults,
    forwards: [],
    env: [],
  },
  {
    id: 'dev',
    name: 'dev-1',
    address: '10.0.0.2',
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: defaults,
    forwards: [],
    env: [],
  },
];

/** The file of the last `ssh.saveHosts` call. */
const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;

beforeEach(() => {
  saveHosts
    .mockReset()
    .mockImplementation(({ file }: { file: HostsFileWire }) =>
      Promise.resolve({ ok: true, value: { file, resolved: RESOLVED, problems: [] } }),
    );
  listHosts.mockResolvedValue({ ok: true, value: { file: FILE, resolved: RESOLVED, problems: [] } });
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
    homeView: 'hosts',
    selectedHostId: undefined,
    detailsOpen: false,
  });
});
afterEach(cleanup);

describe('InheritedSwitch', () => {
  it('one switch: it shows the inherited value with its source, flips it here, and Inherit takes it back', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <InheritedSwitch
        label="Protected"
        provenance={{ value: true, from: { group: 'Production' } }}
        override={undefined}
        onChange={onChange}
      />,
    );
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    const value = screen.getByRole('switch', { name: 'Protected' });
    expect(value.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('on · from Production')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Inherit Protected' })).toBeNull();
    await userEvent.click(value);
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(
      <InheritedSwitch
        label="Protected"
        provenance={{ value: true, from: { group: 'Production' } }}
        override={false}
        onChange={onChange}
      />,
    );
    expect(screen.queryByText('on · from Production')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Inherit Protected' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('with nothing to inherit, flipping back to the default writes nothing', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <InheritedSwitch
        label="Protected"
        provenance={{ value: false, from: 'default' }}
        override={undefined}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('off · default')).toBeDefined();
    await userEvent.click(screen.getByRole('switch', { name: 'Protected' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(
      <InheritedSwitch
        label="Protected"
        provenance={{ value: false, from: 'default' }}
        override={true}
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Inherit Protected' })).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Protected' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('Protected in the host and group forms', () => {
  it('a host under a protected group shows Protected on, from Production', () => {
    render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id: 'api' }} embedded />);
    const value = screen.getByRole('switch', { name: 'Protected' });
    expect(value.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('on · from Production')).toBeDefined();
  });

  it('flipping it writes protected on the host, and Inherit removes it', async () => {
    render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id: 'api' }} embedded />);
    await userEvent.click(screen.getByRole('switch', { name: 'Protected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().groups[0]?.hosts[0]).toMatchObject({ id: 'api', protected: false });

    cleanup();
    const lifted: HostsFileWire = {
      ...FILE,
      groups: [{ ...FILE.groups[0]!, hosts: [{ ...FILE.groups[0]!.hosts[0]!, protected: false }] }],
    };
    useHostsStore.setState({ file: lifted });
    render(<HostForm file={lifted} dialog={{ mode: 'edit-host', id: 'api' }} embedded />);
    await userEvent.click(screen.getByRole('button', { name: 'Inherit Protected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().groups[0]?.hosts[0]).not.toHaveProperty('protected');
  });

  it("a group's dialog sets protected on the group, and saving it again keeps it", async () => {
    render(<HostForm file={FILE} dialog={{ mode: 'new-group' }} embedded />);
    await userEvent.type(screen.getByLabelText('Name'), 'Staging');
    await userEvent.click(screen.getByRole('switch', { name: 'Protected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().groups.at(-1)).toMatchObject({ id: 'staging', protected: true });

    cleanup();
    render(<HostForm file={FILE} dialog={{ mode: 'edit-group', id: 'prod' }} embedded />);
    expect(screen.getByRole('switch', { name: 'Protected' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().groups[0]).toMatchObject({ id: 'prod', protected: true });
  });
});

describe('Protected markers', () => {
  it("a protected host's card shows a shield labelled Protected; an unprotected one does not", () => {
    render(<SshHome />);
    expect(within(screen.getByTestId('host-row-api')).getByRole('img', { name: 'Protected' })).toBeDefined();
    expect(within(screen.getByTestId('host-row-dev')).queryByRole('img', { name: 'Protected' })).toBeNull();
  });

  it("a protected host's details show the shield", () => {
    useHostsStore.setState({ selectedHostId: 'api', detailsOpen: true });
    render(<HostDetails />);
    expect(within(screen.getByTestId('host-details')).getByRole('img', { name: 'Protected' })).toBeDefined();
  });
});
