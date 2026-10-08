import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const secretNames = vi.fn();
const setSecret = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, secretNames, setSecret } }),
}));
import { HostsView } from '../../src/renderer/features/ssh/hosts-view.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

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
      ssh: defaults,
      incomplete: { field: 'user' as const },
    },
    { id: 'b', name: 'beta', address: 'beta.example', tags: [], path: [], ssh: defaults },
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
  useHostsStore.setState({ ...STATE, filter: '', selectedTags: [], dialog: null });
});
afterEach(cleanup);

describe('HostsView', () => {
  it('renders groups, hosts, the needs-badge and the problem banner', () => {
    render(<HostsView />);
    expect(screen.getByText('Production')).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.getByText('needs user')).toBeDefined();
    expect(screen.getByText('ssh-bad-yaml')).toBeDefined();
  });
  it('the filter narrows the tree', async () => {
    render(<HostsView />);
    await userEvent.type(screen.getByLabelText('Filter hosts'), 'beta');
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.queryByText('Production')).toBeNull();
    expect(screen.getByText('beta')).toBeDefined();
  });
  it('editing a host inside a group shows the inherited user with its group', async () => {
    render(<HostsView />);
    await userEvent.dblClick(screen.getByTestId('host-row-a'));
    expect(await screen.findByText('from Production')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('User').disabled).toBe(true);
  });
  it('saving a new host sends the whole file', async () => {
    render(<HostsView />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'gamma');
    await userEvent.type(screen.getByLabelText('Address'), 'gamma.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveHosts).toHaveBeenCalledTimes(1);
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts.map((h) => h.id)).toEqual(['b', 'gamma']);
  });
  it('duplicating twice makes two distinct copies', async () => {
    render(<HostsView />);
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
    render(<HostsView />);
    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.getByText('unresolved')).toBeDefined();
  });
  it('Move to… lists the top level and other groups and moves the host', async () => {
    render(<HostsView />);
    fireEvent.contextMenu(screen.getByTestId('host-row-b'));
    await userEvent.click(await screen.findByText('Move to…'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Production' }));
    const sent = saveHosts.mock.calls[0]?.[0] as { file: typeof STATE.file };
    expect(sent.file.hosts).toEqual([]);
    expect(sent.file.groups[0]?.hosts.map((h) => h.id)).toEqual(['a', 'b']);
  });
  it('the auth picker lists names with a hint for unset ones and Set value stores write-only', async () => {
    render(<HostsView />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.click(await screen.findByRole('radio', { name: 'Password' }));
    expect(await screen.findByRole('option', { name: 'DEPLOY_KEY' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'UNSET (not set on this machine)' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Set value…' }));
    await userEvent.type(screen.getByLabelText('Secret name'), 'NEW_ONE');
    await userEvent.type(screen.getByLabelText('Secret value'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Store' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'NEW_ONE', value: 'pw' });
    expect(secretNames).toHaveBeenCalledTimes(2);
  });
  it('Save stays disabled until a password secret is chosen', async () => {
    render(<HostsView />);
    await userEvent.click(screen.getByRole('button', { name: /New host/ }));
    await userEvent.type(await screen.findByLabelText('Name'), 'x');
    await userEvent.type(screen.getByLabelText('Address'), 'y');
    await userEvent.click(screen.getByRole('radio', { name: 'Password' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });
});
