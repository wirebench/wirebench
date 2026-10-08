// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { resolveHost } from '@wirebench/ssh';
import { parseSecretPseudoRef, secretPseudoRef } from '@wirebench/engine';
import { workspaceSecretGetter, workspaceSecretLabel } from '../src/main/secret-resolver.js';
import { SshSecretsService } from '../src/main/ssh-secrets.js';
import { SSH_DEFAULTS } from '../src/shared/ssh-defaults.js';

/** A tiny in-memory stand-in for the parts of SecretStore the SSH secrets use. */
function fakeStore() {
  const entries = new Map<string, { value: string; label?: string }>();
  let n = 0;
  return {
    entries,
    set: vi.fn((value: string, opts?: { label?: string }) => {
      const ref = `ref-${String(++n)}`;
      entries.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return Promise.resolve(ref);
    }),
    replace: vi.fn((ref: string, value: string) => {
      const entry = entries.get(ref);
      if (entry) entry.value = value;
      return Promise.resolve(ref);
    }),
    get: (ref: string) => Promise.resolve(entries.get(ref)?.value),
    findByLabel: (label: string) => Promise.resolve([...entries].find(([, e]) => e.label === label)?.[0]),
    list: () =>
      Promise.resolve([...entries].map(([ref, e]) => ({ ref, createdAt: '', ...(e.label ? { label: e.label } : {}) }))),
  };
}

describe('workspaceSecretGetter', () => {
  it('reads the workspace-scoped entry and records the value', async () => {
    const store = fakeStore();
    await store.set('s3cret', { label: workspaceSecretLabel('ws1', 'KEY') });
    const record = vi.fn();
    const get = workspaceSecretGetter(store, 'ws1', record);
    expect(await get(secretPseudoRef('KEY'))).toBe('s3cret');
    expect(record).toHaveBeenCalledWith('s3cret');
  });
  it('does not read another workspace or a project-scoped entry; nothing without a workspace', async () => {
    const store = fakeStore();
    await store.set('a', { label: workspaceSecretLabel('ws1', 'KEY') });
    await store.set('b', { label: 'wirebench-secret:ws2:KEY' });
    expect(await workspaceSecretGetter(store, 'ws2', vi.fn())(secretPseudoRef('KEY'))).toBeUndefined();
    expect(await workspaceSecretGetter(store, undefined, vi.fn())(secretPseudoRef('KEY'))).toBeUndefined();
  });
  it('a plain ref reads the store directly', async () => {
    const store = fakeStore();
    const ref = await store.set('plain');
    expect(parseSecretPseudoRef(ref)).toBeUndefined();
    expect(await workspaceSecretGetter(store, undefined, vi.fn())(ref)).toBe('plain');
  });
});

describe('SshSecretsService', () => {
  const make = (workspaceId: string | undefined, mapped: string[] = []) => {
    const store = fakeStore();
    return {
      store,
      service: new SshSecretsService({ store, workspaceId: () => workspaceId, mappedNames: () => mapped }),
    };
  };
  it('set stores under the workspace label and a second set replaces it', async () => {
    const { store, service } = make('ws1');
    await service.set('KEY', 'one');
    await service.set('KEY', 'two');
    expect(store.set).toHaveBeenCalledTimes(1);
    expect([...store.entries.values()]).toEqual([{ value: 'two', label: workspaceSecretLabel('ws1', 'KEY') }]);
  });
  it('set refuses a bad name without echoing it, and refuses without a workspace', async () => {
    await expect(make('ws1').service.set('bad name!', 'v')).rejects.toMatchObject({ code: 'ssh-literal-secret' });
    await expect(make('ws1').service.set('bad name!', 'v')).rejects.not.toThrow(/bad name/);
    await expect(make(undefined).service.set('KEY', 'v')).rejects.toMatchObject({ code: 'workspace-not-open' });
  });
  it('names lists local and mapped names, sorted, only for the open workspace', async () => {
    const { store, service } = make('ws1', ['ZED', 'KEY']);
    await store.set('x', { label: workspaceSecretLabel('ws1', 'KEY') });
    await store.set('y', { label: workspaceSecretLabel('ws1', 'ALPHA') });
    await store.set('z', { label: workspaceSecretLabel('ws2', 'OTHER') });
    expect(await service.names()).toEqual([
      { name: 'ALPHA', local: true, external: false },
      { name: 'KEY', local: true, external: true },
      { name: 'ZED', local: false, external: true },
    ]);
  });
});

describe('SSH_DEFAULTS', () => {
  it('equals the defaults the resolver applies to a bare host', () => {
    const resolved = resolveHost(
      { version: 1, groups: [], hosts: [{ id: 'a', name: 'a', address: 'x', tags: [], ssh: {} }] },
      'a',
    );
    expect({
      port: resolved.ssh.port.value,
      keepAlive: resolved.ssh.keepAlive.value,
      connectTimeout: resolved.ssh.connectTimeout.value,
    }).toEqual(SSH_DEFAULTS);
  });
});
