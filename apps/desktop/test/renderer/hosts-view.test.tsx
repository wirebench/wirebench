import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const sourcesGet = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts }, secretSources: { get: sourcesGet } }),
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
  sourcesGet.mockResolvedValue({
    ok: true,
    value: { open: true, entries: [{ name: 'DEPLOY_KEY' }], trusted: true, changes: [] },
  });
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
});
