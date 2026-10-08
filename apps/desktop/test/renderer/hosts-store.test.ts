import { beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { listHosts, saveHosts } }) }));
import { moveHost, removeGroup, upsertHost, useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const defaults = {
  user: { value: undefined, from: 'default' },
  port: { value: 22, from: 'default' },
  auth: { value: undefined, from: 'default' },
  jump: { value: undefined, from: 'default' },
  keepAlive: { value: 15, from: 'default' },
  connectTimeout: { value: 20, from: 'default' },
} as const;
const RESPONSE = {
  file: {
    version: 1,
    groups: [
      {
        id: 'g',
        name: 'G',
        tags: [],
        ssh: {},
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
      incomplete: { field: 'user' },
    },
    {
      id: 'b',
      name: 'beta',
      address: 'beta.example',
      tags: [],
      path: [],
      ssh: defaults,
      incomplete: { field: 'user' },
    },
  ],
  problems: [],
};

beforeEach(() => {
  listHosts.mockResolvedValue({ ok: true, value: RESPONSE });
  saveHosts.mockResolvedValue({ ok: true, value: RESPONSE });
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [] },
    resolved: [],
    problems: [],
    loaded: false,
    filter: '',
    selectedTags: [],
    dialog: null,
  });
});

describe('hosts store', () => {
  it('refresh loads the file and resolved hosts', async () => {
    await useHostsStore.getState().refresh();
    expect(useHostsStore.getState().loaded).toBe(true);
    expect(
      useHostsStore
        .getState()
        .visibleHosts()
        .map((h) => h.id),
    ).toEqual(['a', 'b']);
  });
  it('filter matches name, address and tags; selected tags narrow further', async () => {
    await useHostsStore.getState().refresh();
    useHostsStore.getState().setFilter('beta.ex');
    expect(
      useHostsStore
        .getState()
        .visibleHosts()
        .map((h) => h.id),
    ).toEqual(['b']);
    useHostsStore.getState().setFilter('');
    useHostsStore.getState().toggleTag('prod');
    expect(
      useHostsStore
        .getState()
        .visibleHosts()
        .map((h) => h.id),
    ).toEqual(['a']);
  });
  it('save sends the whole file; a refused save keeps the old state and records the problem', async () => {
    await useHostsStore.getState().refresh();
    const next = upsertHost(
      useHostsStore.getState().file,
      { id: 'c', name: 'c', address: 'c', tags: [], ssh: {} },
      'g',
    );
    expect(next.groups[0]?.hosts.map((h) => h.id)).toEqual(['a', 'c']);
    expect(await useHostsStore.getState().save(next)).toBe(true);
    expect(saveHosts).toHaveBeenCalledWith({ file: next });
    saveHosts.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-duplicate-id', message: 'dup' } });
    expect(await useHostsStore.getState().save(next)).toBe(false);
    expect(useHostsStore.getState().problems).toEqual([{ code: 'ssh-duplicate-id', message: 'dup' }]);
  });
  it('a refusal carrying a path keeps it on the problem', async () => {
    saveHosts.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ssh-invalid', message: 'bad', details: { path: 'hosts[0].ssh.auth.password' } },
    });
    await useHostsStore.getState().save(RESPONSE.file as never);
    expect(useHostsStore.getState().problems).toEqual([
      { code: 'ssh-invalid', message: 'bad', path: 'hosts[0].ssh.auth.password' },
    ]);
  });
  it('removeGroup refuses a non-empty group', () => {
    expect(() => removeGroup(RESPONSE.file as never, 'g')).toThrow(/not empty/);
  });
  it('moveHost moves a host between a group and the root', () => {
    const moved = moveHost(RESPONSE.file as never, 'a', undefined);
    expect(moved.groups[0]?.hosts).toEqual([]);
    expect(moved.hosts.map((h) => h.id)).toEqual(['b', 'a']);
  });
});
