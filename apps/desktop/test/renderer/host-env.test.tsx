import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const setHostOs = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const secretNames = vi.fn(() =>
  Promise.resolve({ ok: true, value: { names: [{ name: 'api_token', local: true, external: false }] } }),
);
const knownHosts = vi.fn(() => Promise.resolve({ ok: true, value: { entries: [] } }));
const keys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, setHostOs, secretNames, knownHosts, keys } }),
}));
import { inheritedEnv } from '../../src/renderer/features/ssh/env-section.js';
import { HostDetails } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'prod',
      name: 'Production',
      tags: [],
      ssh: {},
      env: [
        { name: 'LANG', value: 'en_US.UTF-8' },
        { name: 'TOKEN', secret: 'prod_token' },
      ],
      groups: [
        {
          id: 'eu',
          name: 'EU',
          tags: [],
          ssh: {},
          env: [{ name: 'LANG', value: 'C.UTF-8' }],
          groups: [],
          hosts: [
            { id: 'db-1', name: 'db-1', address: '10.0.1.7', tags: [], ssh: {}, env: [{ name: 'APP', value: 'x' }] },
          ],
        },
      ],
      hosts: [],
    },
  ],
  hosts: [],
};

const RESOLVED: ResolvedHostWire[] = [];

const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;
const savedHost = () => saved().groups[0]!.groups[0]!.hosts[0]!;

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
    dialog: { mode: 'edit-host', id: 'db-1' },
    osByHost: {},
    homeView: 'hosts',
  });
});
afterEach(() => {
  cleanup();
});

const editDb1 = () => render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id: 'db-1' }} embedded />);
const section = () => screen.getByRole('region', { name: 'Environment variables' });
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('inheritedEnv', () => {
  it('merges by name down the chain, nearest group wins, first-definition order', () => {
    const prod = FILE.groups[0]!;
    expect(inheritedEnv([prod, prod.groups[0]!])).toEqual([
      { variable: { name: 'LANG', value: 'C.UTF-8' }, from: 'EU' },
      { variable: { name: 'TOKEN', secret: 'prod_token' }, from: 'Production' },
    ]);
  });
});

describe('the environment section of the host form', () => {
  it('shows inherited variables greyed with their group, a secret by name only', () => {
    editDb1();
    const rows = within(section()).getAllByTestId('inherited-env');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('LANG=C.UTF-8from EU'),
      expect.stringContaining('TOKEN=secret prod_tokenfrom Production'),
    ]);
    expect(within(section()).getByLabelText<HTMLInputElement>('Variable name').value).toBe('APP');
  });

  it('adds a text variable and a secret one; saving writes them in order', async () => {
    editDb1();
    await userEvent.click(within(section()).getByRole('button', { name: 'Add variable' }));
    const names = within(section()).getAllByLabelText<HTMLInputElement>('Variable name');
    await userEvent.type(names[1]!, 'HTTP_PROXY');
    await userEvent.type(within(section()).getByLabelText('Value of HTTP_PROXY'), 'http://proxy:3128');
    await userEvent.click(within(section()).getByRole('button', { name: 'Add variable' }));
    await userEvent.type(within(section()).getAllByLabelText('Variable name')[2]!, 'API_TOKEN');
    await userEvent.selectOptions(within(section()).getByLabelText('Kind of API_TOKEN'), 'secret');
    await userEvent.selectOptions(await within(section()).findByLabelText('Secret for API_TOKEN'), 'api_token');
    await save();
    expect(savedHost().env).toEqual([
      { name: 'APP', value: 'x' },
      { name: 'HTTP_PROXY', value: 'http://proxy:3128' },
      { name: 'API_TOKEN', secret: 'api_token' },
    ]);
  });

  it('Override copies an inherited variable here, editable', async () => {
    editDb1();
    await userEvent.click(within(section()).getByRole('button', { name: 'Override LANG' }));
    expect(within(section()).getAllByTestId('inherited-env')[0]!.textContent).toContain('overridden here');
    const value = within(section()).getByLabelText('Value of LANG');
    await userEvent.clear(value);
    await userEvent.type(value, 'de_DE.UTF-8');
    await save();
    expect(savedHost().env).toEqual([
      { name: 'APP', value: 'x' },
      { name: 'LANG', value: 'de_DE.UTF-8' },
    ]);
  });

  it('Save waits for a valid list: a bad name, a name twice, a secret token typed as text', async () => {
    editDb1();
    const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    const name = within(section()).getByLabelText('Variable name');
    await userEvent.clear(name);
    await userEvent.type(name, 'BAD-NAME');
    expect(saveButton().disabled).toBe(true);
    expect(within(section()).getByRole('alert').textContent).toContain('BAD-NAME is not a variable name');
    await userEvent.clear(name);
    await userEvent.type(name, 'A');
    await userEvent.click(within(section()).getByRole('button', { name: 'Add variable' }));
    await userEvent.type(within(section()).getAllByLabelText('Variable name')[1]!, 'A');
    expect(within(section()).getByRole('alert').textContent).toContain('A is listed twice');
    expect(saveButton().disabled).toBe(true);
    await userEvent.click(within(section()).getAllByRole('button', { name: 'Remove A' })[1]!);
    expect(saveButton().disabled).toBe(false);
    const value = within(section()).getByLabelText('Value of A');
    await userEvent.clear(value);
    await userEvent.type(value, '${{secret:x}');
    expect(within(section()).getByRole('alert').textContent).toContain('choose Secret');
    expect(saveButton().disabled).toBe(true);
  });

  it('removing every variable writes no env key', async () => {
    editDb1();
    await userEvent.click(within(section()).getByRole('button', { name: 'Remove APP' }));
    await save();
    expect(savedHost()).not.toHaveProperty('env');
  });
});

describe('the environment in host details', () => {
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
    env: [
      { name: 'LANG', value: 'C.UTF-8', from: { group: 'eu' } },
      { name: 'TOKEN', secret: 'prod_token', from: { group: 'prod' } },
      { name: 'APP', value: 'x', from: 'host' },
    ],
  };

  it('lists each resolved variable with its source; a secret by name and whether it has a value', async () => {
    useHostsStore.setState({ resolved: [host], selectedHostId: 'db-1', detailsOpen: true, dialog: null });
    render(<HostDetails />);
    const env = screen.getByRole('region', { name: 'Environment' });
    await vi.waitFor(() => expect(env.textContent).toContain('no value on this machine'));
    expect(env.textContent).toContain('LANGC.UTF-8from EU');
    expect(env.textContent).toContain('TOKENprod_token');
    expect(env.textContent).toContain('from Production');
    expect(env.textContent).toContain('APPxset on host');
  });

  it('shows no Environment section for a host without variables', () => {
    useHostsStore.setState({
      resolved: [{ ...host, env: [] }],
      selectedHostId: 'db-1',
      detailsOpen: true,
      dialog: null,
    });
    render(<HostDetails />);
    expect(screen.queryByRole('region', { name: 'Environment' })).toBeNull();
  });
});
