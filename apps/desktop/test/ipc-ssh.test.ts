// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostsService } from '../src/main/hosts-service.js';
import { registerSshChannels } from '../src/main/areas/ssh.js';
import { SnippetsService } from '../src/main/snippets-service.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: {} }, payload);
}
function invokeAs(sender: object, channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender }, payload);
}

const NO_SECRETS = { names: vi.fn(), set: vi.fn() };
const NO_SSH = {
  connect: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  close: vi.fn(),
  trust: vi.fn(),
  knownHosts: vi.fn(),
  forgetHostKey: vi.fn(),
  hostOs: vi.fn(),
  setHostOs: vi.fn(),
};
const NO_HOSTS = { list: vi.fn(), save: vi.fn() };
const NO_SNIPPETS = { list: vi.fn(), save: vi.fn() };
const NO_IMPORT = { preview: vi.fn(), apply: vi.fn() };
const NO_KEYS = { generate: vi.fn(), keys: vi.fn(), install: vi.fn() };
const NO_SFTP = {
  open: vi.fn(),
  close: vi.fn(),
  list: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  chmod: vi.fn(),
};
const NO_TRANSFERS = { copy: vi.fn(), resolve: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
const EMPTY = { file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] };

beforeEach(() => {
  handlers.clear();
});

describe('ssh channels', () => {
  it('a refused save answers its own code, not internal-error, and never echoes the bad name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-ipc-ssh-'));
    registerSshChannels({
      hosts: new HostsService({ treeDir: () => dir }),
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const host = {
      id: 'a',
      name: 'A',
      address: 'x',
      tags: [],
      ssh: { auth: { kind: 'password', secret: 'hunter two' } },
    };
    const answer = (await invoke('ssh.saveHosts', { file: { version: 1, groups: [], hosts: [host] } })) as {
      ok: boolean;
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(answer.ok).toBe(false);
    expect(answer.error.code).toBe('ssh-literal-secret');
    expect(JSON.stringify(answer)).not.toContain('hunter');
  });
  it('a stray key in the request is an invalid request', async () => {
    registerSshChannels({
      hosts: { list: vi.fn(), save: vi.fn() },
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const answer = (await invoke('ssh.saveHosts', { file: { ...EMPTY.file, extra: 1 } })) as { ok: boolean };
    expect(answer.ok).toBe(false);
  });
  it('ssh.listHosts answers the service; ssh.saveHosts passes the file through', async () => {
    const list = vi.fn().mockResolvedValue(EMPTY);
    const save = vi.fn().mockResolvedValue(EMPTY);
    registerSshChannels({
      hosts: { list, save },
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(await invoke('ssh.listHosts', undefined)).toEqual({ ok: true, value: EMPTY });
    await invoke('ssh.saveHosts', { file: EMPTY.file });
    expect(save).toHaveBeenCalledWith(EMPTY.file);
  });
  it('ssh.secretNames answers names and where they live, never a value', async () => {
    const names = vi.fn().mockResolvedValue([{ name: 'DEPLOY_KEY', local: true, external: false }]);
    registerSshChannels({
      hosts: { list: vi.fn(), save: vi.fn() },
      secrets: { names, set: vi.fn() },
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(await invoke('ssh.secretNames', undefined)).toEqual({
      ok: true,
      value: { names: [{ name: 'DEPLOY_KEY', local: true, external: false }] },
    });
  });
  it('ssh.setSecret stores through the service and no response carries the value', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    registerSshChannels({
      hosts: { list: vi.fn(), save: vi.fn() },
      secrets: { names: vi.fn(), set },
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const answer = await invoke('ssh.setSecret', { name: 'DEPLOY_KEY', value: 'hunter2-value' });
    expect(set).toHaveBeenCalledWith('DEPLOY_KEY', 'hunter2-value');
    expect(answer).toEqual({ ok: true, value: {} });
    expect(JSON.stringify(answer)).not.toContain('hunter2');
  });
  it('a refused ssh.setSecret answers its code and does not echo the name or value', async () => {
    const { SshSecretsService } = await import('../src/main/ssh-secrets.js');
    const service = new SshSecretsService({
      store: { set: vi.fn(), replace: vi.fn(), findByLabel: vi.fn(), list: vi.fn() },
      workspaceId: () => 'ws',
      mappedNames: () => [],
    });
    registerSshChannels({
      hosts: { list: vi.fn(), save: vi.fn() },
      secrets: service,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const answer = await invoke('ssh.setSecret', { name: 'my password!', value: 'hunter2-value' });
    expect(JSON.stringify(answer)).toContain('ssh-literal-secret');
    expect(JSON.stringify(answer)).not.toContain('hunter2');
    expect(JSON.stringify(answer)).not.toContain('my password');
  });
  it('a stray key in ssh.setSecret is an invalid request', async () => {
    registerSshChannels({
      hosts: { list: vi.fn(), save: vi.fn() },
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const answer = (await invoke('ssh.setSecret', { name: 'A', value: 'v', extra: 1 })) as { ok: boolean };
    expect(answer.ok).toBe(false);
  });

  describe('session channels forward the calling window as the owner', () => {
    const window = { id: 7 };
    function register() {
      const ssh = {
        connect: vi.fn().mockResolvedValue({ sessionId: 's1' }),
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(),
        trust: vi.fn().mockResolvedValue(undefined),
        knownHosts: vi.fn(),
        forgetHostKey: vi.fn(),
        hostOs: vi.fn(),
        setHostOs: vi.fn(),
      };
      registerSshChannels({
        hosts: NO_HOSTS,
        secrets: NO_SECRETS,
        ssh,
        importer: NO_IMPORT,
        keys: NO_KEYS,
        sftp: NO_SFTP,
        snippets: NO_SNIPPETS,
        transfers: NO_TRANSFERS,
      });
      return ssh;
    }
    it('ssh.connect', async () => {
      const ssh = register();
      const request = { hostId: 'a', cols: 80, rows: 24 };
      expect(await invokeAs(window, 'ssh.connect', request)).toEqual({ ok: true, value: { sessionId: 's1' } });
      expect(ssh.connect).toHaveBeenCalledWith(window, request);
    });
    it('ssh.write', async () => {
      const ssh = register();
      expect(await invokeAs(window, 'ssh.write', { sessionId: 's1', data: 'aGk=' })).toEqual({ ok: true, value: {} });
      expect(ssh.write).toHaveBeenCalledWith(window, { sessionId: 's1', data: 'aGk=' });
    });
    it('ssh.resize', async () => {
      const ssh = register();
      await invokeAs(window, 'ssh.resize', { sessionId: 's1', cols: 100, rows: 30 });
      expect(ssh.resize).toHaveBeenCalledWith(window, { sessionId: 's1', cols: 100, rows: 30 });
    });
    it('ssh.close', async () => {
      const ssh = register();
      await invokeAs(window, 'ssh.close', { sessionId: 's1' });
      expect(ssh.close).toHaveBeenCalledWith(window, { sessionId: 's1' });
    });
    it('ssh.trustHostKey defaults replace to false', async () => {
      const ssh = register();
      const key = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };
      expect(await invokeAs(window, 'ssh.trustHostKey', key)).toEqual({ ok: true, value: {} });
      expect(ssh.trust).toHaveBeenCalledWith(window, { ...key, replace: false });
    });
    it('a refused connect keeps its code and details across the bridge', async () => {
      const { WirebenchError } = await import('@wirebench/engine');
      const ssh = register();
      const details = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };
      ssh.connect.mockRejectedValue(new WirebenchError('ssh-host-key-new', 'untrusted', { details }));
      const answer = (await invokeAs(window, 'ssh.connect', { hostId: 'a', cols: 80, rows: 24 })) as {
        ok: boolean;
        error: { code: string; details?: Record<string, unknown> };
      };
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatchObject({ code: 'ssh-host-key-new', details });
    });
  });
});

describe('known hosts channels', () => {
  it('list the trusted keys and forget one by host and key type', async () => {
    const entry = { host: 'box:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' };
    const ssh = { ...NO_SSH, knownHosts: vi.fn().mockResolvedValue([entry]), forgetHostKey: vi.fn() };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(await invoke('ssh.knownHosts', undefined)).toEqual({ ok: true, value: { entries: [entry] } });
    expect(await invoke('ssh.forgetHostKey', { host: 'box:22', keyType: 'ssh-ed25519' })).toEqual({
      ok: true,
      value: {},
    });
    expect(ssh.forgetHostKey).toHaveBeenCalledWith({ host: 'box:22', keyType: 'ssh-ed25519' });
  });

  it('refuse a forget request with anything beyond host and key type', async () => {
    const ssh = { ...NO_SSH, forgetHostKey: vi.fn() };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(
      await invoke('ssh.forgetHostKey', { host: 'box:22', keyType: 'ssh-ed25519', fingerprint: 'x' }),
    ).toMatchObject({ ok: false });
    expect(ssh.forgetHostKey).not.toHaveBeenCalled();
  });
});

describe('host OS channels', () => {
  const window = { id: 7 };
  it('list the entries and forward a choice with the calling window', async () => {
    const entries = { 'box:22': { detected: { id: 'ubuntu', name: 'Ubuntu' }, chosen: 'debian' } };
    const ssh = {
      ...NO_SSH,
      hostOs: vi.fn().mockResolvedValue(entries),
      setHostOs: vi.fn().mockResolvedValue(undefined),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(await invoke('ssh.hostOs', undefined)).toEqual({ ok: true, value: { entries } });
    expect(await invokeAs(window, 'ssh.setHostOs', { host: 'box:22', os: 'alpine' })).toEqual({ ok: true, value: {} });
    expect(await invokeAs(window, 'ssh.setHostOs', { host: 'box:22', os: null })).toEqual({ ok: true, value: {} });
    expect(ssh.setHostOs).toHaveBeenNthCalledWith(1, window, { host: 'box:22', os: 'alpine' });
    expect(ssh.setHostOs).toHaveBeenNthCalledWith(2, window, { host: 'box:22', os: null });
  });

  it('refuse an unknown OS id and extra fields', async () => {
    const ssh = { ...NO_SSH, setHostOs: vi.fn() };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(await invoke('ssh.setHostOs', { host: 'box:22', os: 'beos' })).toMatchObject({ ok: false });
    expect(await invoke('ssh.setHostOs', { host: 'box:22', os: null, extra: 1 })).toMatchObject({ ok: false });
    expect(ssh.setHostOs).not.toHaveBeenCalled();
  });
});

describe('ssh import channels', () => {
  it('pass the calling window as the owner of a preview and an apply', async () => {
    const preview = vi.fn().mockResolvedValue({ cancelled: true });
    const apply = vi.fn().mockResolvedValue({ ...EMPTY, groupId: 'ssh-config', stored: [] });
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: { preview, apply },
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const window = { id: 7 };
    expect(await invokeAs(window, 'ssh.importPreview', { source: 'user-config' })).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    expect(preview).toHaveBeenCalledWith(window, { source: 'user-config' });
    const request = { previewId: 'p', groupName: 'SSH config', importDuplicates: [], keys: [] };
    await invokeAs(window, 'ssh.importApply', request);
    expect(apply).toHaveBeenCalledWith(window, request);
  });

  it('refuse a preview request that carries a path', async () => {
    const preview = vi.fn();
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: { preview, apply: vi.fn() },
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    expect(await invoke('ssh.importPreview', { source: 'pick', path: '/etc/passwd' })).toMatchObject({ ok: false });
    expect(preview).not.toHaveBeenCalled();
  });

  it('sftp channels act for the sender, who owns the session', async () => {
    const sftp = {
      ...NO_SFTP,
      list: vi.fn(() => Promise.resolve({ path: '/srv', entries: [] })),
      chmod: vi.fn(() => Promise.resolve()),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const window = { id: 3 };
    const place = { kind: 'remote', sessionId: 's1' };
    await expect(invokeAs(window, 'sftp.list', { place, path: '/srv' })).resolves.toEqual({
      ok: true,
      value: { path: '/srv', entries: [] },
    });
    expect(sftp.list).toHaveBeenCalledWith(window, { place, path: '/srv' });
    await expect(invokeAs(window, 'sftp.chmod', { place, path: '/a', mode: 0o10000 })).resolves.toMatchObject({
      ok: false,
    });
    expect(sftp.chmod).not.toHaveBeenCalled();
    await expect(invokeAs(window, 'sftp.close', { sessionId: 's1' })).resolves.toEqual({ ok: true, value: {} });
    expect(sftp.close).toHaveBeenCalledWith(window, { sessionId: 's1' });
  });

  it('transfer channels act for the sender, whose copies they are', async () => {
    const transfers = {
      copy: vi.fn(() => Promise.resolve({ transferIds: ['t1'] })),
      resolve: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers,
      snippets: NO_SNIPPETS,
    });
    const window = { id: 4 };
    const copy = {
      batchId: 'b',
      from: { place: { kind: 'local' }, paths: ['/a'] },
      to: { place: { kind: 'remote', sessionId: 's1' }, dir: '/srv' },
    };
    await expect(invokeAs(window, 'sftp.copy', copy)).resolves.toEqual({ ok: true, value: { transferIds: ['t1'] } });
    expect(transfers.copy).toHaveBeenCalledWith(window, copy);
    await expect(
      invokeAs(window, 'sftp.copy', { ...copy, from: { place: { kind: 'local' }, paths: [] } }),
    ).resolves.toMatchObject({ ok: false });
    await invokeAs(window, 'sftp.resolve', { batchId: 'b', decision: 'skip', applyToRest: true });
    expect(transfers.resolve).toHaveBeenCalledWith(window, { batchId: 'b', decision: 'skip', applyToRest: true });
    await invokeAs(window, 'sftp.cancel', { transferId: 't1' });
    expect(transfers.cancel).toHaveBeenCalledWith(window, { transferId: 't1' });
    await invokeAs(window, 'sftp.retry', { transferId: 't1' });
    expect(transfers.retry).toHaveBeenCalledWith(window, { transferId: 't1' });
  });
});

describe('ssh key channels', () => {
  it('pass the calling window to keys and install, and refuse a stray field on generate', async () => {
    const keys = {
      generate: vi.fn(),
      keys: vi.fn(() => Promise.resolve([{ name: 'k', locked: true }])),
      install: vi.fn(() => Promise.resolve({ result: 'added' as const })),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      transfers: NO_TRANSFERS,
    });
    const window = { id: 4 };
    expect(await invokeAs(window, 'ssh.keys', undefined)).toEqual({
      ok: true,
      value: { keys: [{ name: 'k', locked: true }] },
    });
    expect(keys.keys).toHaveBeenCalledWith(window);
    expect(await invokeAs(window, 'ssh.installKey', { secret: 'k', hostId: 'web' })).toEqual({
      ok: true,
      value: { result: 'added' },
    });
    expect(keys.install).toHaveBeenCalledWith(window, { secret: 'k', hostId: 'web' });
    const stray = (await invoke('ssh.generateKey', { name: 'k', algorithm: 'ed25519', privateKey: 'x' })) as {
      ok: boolean;
    };
    expect(stray.ok).toBe(false);
    expect(keys.generate).not.toHaveBeenCalled();
  });
});

describe('snippet channels', () => {
  const EMPTY_SNIPPETS = { file: { version: 1, packages: [], snippets: [] }, snippets: [], problems: [] };

  it('ssh.listSnippets answers the service; ssh.saveSnippets passes the file through', async () => {
    const snippets = {
      list: vi.fn().mockResolvedValue(EMPTY_SNIPPETS),
      save: vi.fn().mockResolvedValue(EMPTY_SNIPPETS),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers: NO_TRANSFERS,
      snippets,
    });
    expect(await invoke('ssh.listSnippets', undefined)).toEqual({ ok: true, value: EMPTY_SNIPPETS });
    await invoke('ssh.saveSnippets', { file: EMPTY_SNIPPETS.file });
    expect(snippets.save).toHaveBeenCalledWith(EMPTY_SNIPPETS.file);
  });

  it('a refused save answers its own code, not internal-error, and a stray key is an invalid request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-ipc-snippets-'));
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers: NO_TRANSFERS,
      snippets: new SnippetsService({ treeDir: () => dir }),
    });
    const snippet = { id: 'Bad Id', name: 'x', tags: [], variables: [], script: 'ls', enter: true, confirm: false };
    const refused = (await invoke('ssh.saveSnippets', {
      file: { version: 1, packages: [], snippets: [snippet] },
    })) as { ok: boolean; error: { code: string } };
    expect(refused).toMatchObject({ ok: false, error: { code: 'snippets-invalid' } });
    const stray = (await invoke('ssh.saveSnippets', { file: { ...EMPTY_SNIPPETS.file, extra: 1 } })) as {
      ok: boolean;
      error: { code: string };
    };
    expect(stray.ok).toBe(false);
    expect(stray.error.code).not.toBe('snippets-invalid');
  });
});
