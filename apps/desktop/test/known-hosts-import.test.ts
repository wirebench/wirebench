// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { KnownHostEntry } from '@wirebench/ssh';
import { HostsService } from '../src/main/hosts-service.js';
import { KnownHostsImportService } from '../src/main/known-hosts-import.js';
import type { SshImportFs } from '../src/main/ssh-import.js';
import type { SshKnownHostsImportPreview } from '../src/shared/ssh-wire.js';

const HOME = '/home/u';
const KNOWN_HOSTS = '/home/u/.ssh/known_hosts';
const FIXTURE = readFileSync(new URL('../../../packages/ssh/test/fixtures/known_hosts', import.meta.url), 'utf8');
const ED = 'ssh-ed25519';
const FP_A = 'SHA256:zXKOo91Z+uaXv5p6WtsMIte0yY6ZWYRdRmkIcAbuVF8';
const FP_B = 'SHA256:V2DUyxbxrFsZDteUJdP0ohJZF62/h2Kx1ka5w8w4Odc';
const FP_D = 'SHA256:WSVIBsv2b8Jo9LYTQaTPfjNLlL/DO+t8JT7x9GRyq4E';

const HOSTS_YAML = `version: 1
groups: []
hosts:
  - id: plain
    name: Plain
    address: plain.example.com
  - id: hashed
    name: Hashed
    address: hashed.example.com
  - id: port
    name: Port
    address: port.example.com
    ssh:
      port: 2222
`;

function fakeFs(files: Record<string, string | { size: number }>): SshImportFs {
  const get = (path: string) => {
    const entry = files[path];
    if (entry === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return entry;
  };
  return {
    realpath: (path) => Promise.resolve().then(() => (get(path), path)),
    stat: (path) =>
      Promise.resolve().then(() => {
        const entry = get(path);
        return { isFile: () => true, size: typeof entry === 'string' ? entry.length : entry.size };
      }),
    readFile: (path) => Promise.resolve().then(() => get(path) as string),
    readBytes: (path) => Promise.resolve().then(() => Buffer.from(get(path) as string)),
    glob: () => Promise.resolve([]),
  };
}

/** The trusted-keys store, in memory, with the same read-change-write shape as `SshService`. */
function fakeStore(initial: KnownHostEntry[] = []) {
  const store = {
    entries: initial,
    knownHosts: () => Promise.resolve(store.entries),
    changeKnownHosts: <T extends { readonly entries: readonly KnownHostEntry[] }>(
      change: (known: readonly KnownHostEntry[]) => T,
    ): Promise<T> => {
      const changed = change(store.entries);
      store.entries = [...changed.entries];
      return Promise.resolve(changed);
    },
  };
  return store;
}

function setup(
  files: Record<string, string | { size: number }>,
  options: { hostsYaml?: string; trusted?: KnownHostEntry[]; now?: () => number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-known-hosts-'));
  writeFileSync(join(dir, 'hosts.yaml'), options.hostsYaml ?? HOSTS_YAML);
  const hosts = new HostsService({ treeDir: () => dir });
  const store = fakeStore(options.trusted);
  const pick = vi.fn().mockResolvedValue(undefined);
  const service = new KnownHostsImportService({
    home: () => HOME,
    pick,
    hosts,
    store,
    fs: fakeFs(files),
    now: options.now ?? (() => 0),
  });
  return { service, store, pick, dir };
}
const A = { id: 1 };
const B = { id: 2 };
const asPreview = (value: unknown): SshKnownHostsImportPreview => value as SshKnownHostsImportPreview;

describe('KnownHostsImportService.preview', () => {
  it('reads ~/.ssh/known_hosts and matches it against the hosts in hosts.yaml', async () => {
    const { service } = setup({ [KNOWN_HOSTS]: FIXTURE });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    expect(preview.source).toBe('~/.ssh/known_hosts');
    expect(preview.add.map((r) => [r.host, r.keyType, r.fingerprint, r.names])).toEqual([
      ['plain.example.com:22', ED, FP_A, ['Plain']],
      ['port.example.com:2222', ED, FP_D, ['Port']],
      ['hashed.example.com:22', ED, FP_B, ['Hashed']],
      ['plain.example.com:22', 'ecdsa-sha2-nistp256', 'SHA256:rHy7n9a5k3LHcfddoDNzL4TRlhV0uq5rQEAeErKnZEM', ['Plain']],
    ]);
    expect(preview.skipped).toContainEqual({ line: 9, reason: 'cert-authority' });
    expect(preview.skipped).toContainEqual({ line: 10, reason: 'revoked' });
  });

  it('uses the picker for pick, and a cancelled pick is a cancellation', async () => {
    const { service, pick } = setup({ '/elsewhere/hosts': FIXTURE });
    expect(await service.preview(A, { source: 'pick' })).toEqual({ cancelled: true });
    pick.mockResolvedValueOnce('/elsewhere/hosts');
    expect(asPreview(await service.preview(A, { source: 'pick' })).source).toBe('/elsewhere/hosts');
  });

  it('refuses a missing or oversized file with ssh-known-hosts-unreadable', async () => {
    await expect(setup({}).service.preview(A, { source: 'user-known-hosts' })).rejects.toMatchObject({
      code: 'ssh-known-hosts-unreadable',
      message: '~/.ssh/known_hosts could not be read (ENOENT)',
    });
    await expect(
      setup({ [KNOWN_HOSTS]: { size: 64 * 1024 * 1024 } }).service.preview(A, { source: 'user-known-hosts' }),
    ).rejects.toMatchObject({ code: 'ssh-known-hosts-unreadable' });
  });

  it('refuses while hosts.yaml has problems', async () => {
    const { service } = setup({ [KNOWN_HOSTS]: FIXTURE }, { hostsYaml: 'version: 1\nhosts: [{ id: 1 }]\n' });
    await expect(service.preview(A, { source: 'user-known-hosts' })).rejects.toMatchObject({
      code: 'ssh-hosts-invalid',
    });
  });
});

describe('KnownHostsImportService.apply', () => {
  const conflicting: KnownHostEntry[] = [{ host: 'port.example.com:2222', keyType: ED, fingerprint: FP_A }];

  it('adds the new keys and keeps a conflicting one that was not chosen', async () => {
    const { service, store } = setup({ [KNOWN_HOSTS]: FIXTURE }, { trusted: conflicting });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    expect(preview.conflicts.map((c) => [c.host, c.fingerprint, c.previous])).toEqual([
      ['port.example.com:2222', FP_D, FP_A],
    ]);
    expect(await service.apply(A, { previewId: preview.previewId, replace: [] })).toEqual({
      added: 3,
      replaced: 0,
      kept: 1,
      hostsAdded: 0,
    });
    expect(store.entries).toContainEqual(conflicting[0]);
    expect(store.entries).toContainEqual({ host: 'hashed.example.com:22', keyType: ED, fingerprint: FP_B });
  });

  it('replaces a chosen conflict, and only a conflict can be chosen', async () => {
    const { service, store } = setup({ [KNOWN_HOSTS]: FIXTURE }, { trusted: conflicting });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    // A key trusted after the preview for a row that was an addition then: not a conflict, never replaced.
    store.entries = [...store.entries, { host: 'hashed.example.com:22', keyType: ED, fingerprint: FP_A }];
    const result = await service.apply(A, {
      previewId: preview.previewId,
      replace: [
        { host: 'port.example.com:2222', keyType: ED },
        { host: 'hashed.example.com:22', keyType: ED },
      ],
    });
    expect(result).toEqual({ added: 2, replaced: 1, kept: 1, hostsAdded: 0 });
    expect(store.entries).toContainEqual({ host: 'port.example.com:2222', keyType: ED, fingerprint: FP_D });
    expect(store.entries).toContainEqual({ host: 'hashed.example.com:22', keyType: ED, fingerprint: FP_A });
  });

  it('refuses an unknown, expired, used or other window preview with ssh-import-expired', async () => {
    let now = 0;
    const { service } = setup({ [KNOWN_HOSTS]: FIXTURE }, { now: () => now });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    await expect(service.apply(B, { previewId: preview.previewId, replace: [] })).rejects.toMatchObject({
      code: 'ssh-import-expired',
    });
    await service.apply(A, { previewId: preview.previewId, replace: [] });
    await expect(service.apply(A, { previewId: preview.previewId, replace: [] })).rejects.toMatchObject({
      code: 'ssh-import-expired',
    });
    const late = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    now = 11 * 60 * 1000;
    await expect(service.apply(A, { previewId: late.previewId, replace: [] })).rejects.toMatchObject({
      code: 'ssh-import-expired',
    });
  });
});

describe('KnownHostsImportService unsaved hosts (#572)', () => {
  const UNRELATED = 'unrelated.example.org:22';
  const GROUPED = `version: 1
groups:
  - id: lab
    name: Lab
hosts:
  - id: plain
    name: Plain
    address: plain.example.com
`;

  it('lists the servers plain lines name that no host dials, and adds none unasked', async () => {
    const { service, store, dir } = setup({ [KNOWN_HOSTS]: FIXTURE });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    expect(preview.unsaved).toEqual([
      {
        host: UNRELATED,
        address: 'unrelated.example.org',
        port: 22,
        keys: [{ keyType: ED, fingerprint: FP_A, line: 11 }],
      },
    ]);
    expect(preview.skipped).not.toContainEqual({ line: 11, reason: 'no-host' });
    const before = readFileSync(join(dir, 'hosts.yaml'), 'utf8');
    expect((await service.apply(A, { previewId: preview.previewId, replace: [] })).hostsAdded).toBe(0);
    expect(readFileSync(join(dir, 'hosts.yaml'), 'utf8')).toBe(before);
    expect(store.entries.map((e) => e.host)).not.toContain(UNRELATED);
  });

  it('adds a chosen server at the top level with no user, and trusts its key', async () => {
    const { service, store, dir } = setup({ [KNOWN_HOSTS]: FIXTURE });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    const result = await service.apply(A, { previewId: preview.previewId, replace: [], addHosts: [UNRELATED] });
    expect(result).toEqual({ added: 5, replaced: 0, kept: 0, hostsAdded: 1 });
    const listed = await new HostsService({ treeDir: () => dir }).list();
    expect(listed.file.hosts.map((h) => [h.id, h.name, h.address, h.ssh.user])).toContainEqual([
      'unrelated-example-org',
      'unrelated.example.org',
      'unrelated.example.org',
      undefined,
    ]);
    expect(store.entries).toContainEqual({ host: UNRELATED, keyType: ED, fingerprint: FP_A });
  });

  it('adds into the group chosen, and only servers the preview offered', async () => {
    const { service, store, dir } = setup({ [KNOWN_HOSTS]: FIXTURE }, { hostsYaml: GROUPED });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    expect(preview.unsaved.map((s) => s.host)).toEqual(['port.example.com:2222', UNRELATED]);
    const result = await service.apply(A, {
      previewId: preview.previewId,
      replace: [],
      addHosts: [UNRELATED, 'never.offered:22'],
      group: 'lab',
    });
    expect(result.hostsAdded).toBe(1);
    const listed = await new HostsService({ treeDir: () => dir }).list();
    expect(listed.file.groups[0]?.hosts.map((h) => h.address)).toEqual(['unrelated.example.org']);
    expect(store.entries.map((e) => e.host)).not.toContain('never.offered:22');
  });

  it('refuses a group gone since the preview with ssh-import-stale, trusting nothing', async () => {
    const { service, store } = setup({ [KNOWN_HOSTS]: FIXTURE }, { hostsYaml: GROUPED });
    const preview = asPreview(await service.preview(A, { source: 'user-known-hosts' }));
    await expect(
      service.apply(A, { previewId: preview.previewId, replace: [], addHosts: [UNRELATED], group: 'gone' }),
    ).rejects.toMatchObject({ code: 'ssh-import-stale' });
    expect(store.entries).toEqual([]);
  });
});
