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
  writeMany: vi.fn(),
  resize: vi.fn(),
  close: vi.fn(),
  trust: vi.fn(),
  knownHosts: vi.fn(),
  forgetHostKey: vi.fn(),
  hostOs: vi.fn(),
  setHostOs: vi.fn(),
  runSnippet: vi.fn(),
  previewSnippet: vi.fn(),
};
const NO_HOSTS = { list: vi.fn(), save: vi.fn() };
const NO_SNIPPETS = { list: vi.fn(), save: vi.fn() };
const NO_LAYOUTS = {
  layouts: { list: vi.fn(), save: vi.fn(), rename: vi.fn(), delete: vi.fn() },
  workspaceId: () => undefined,
};
const NO_FORWARD = {
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  stopAll: vi.fn(),
  freePort: vi.fn(),
  hostsChanged: vi.fn(() => Promise.resolve()),
};
const NO_SESSION_LOGS = {
  logs: { list: vi.fn(), read: vi.fn(), search: vi.fn(), remove: vi.fn(), pathOf: vi.fn() },
  switches: { all: vi.fn(), set: vi.fn() },
  workspaceOf: (): string | undefined => undefined,
  reveal: vi.fn(),
};
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
const NO_EDITS = { edit: vi.fn(), reply: vi.fn(), end: vi.fn() };
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
    expect(await invoke('ssh.listHosts', undefined)).toEqual({ ok: true, value: EMPTY });
    const window = { id: 3 };
    await invokeAs(window, 'ssh.saveHosts', { file: EMPTY.file });
    expect(save).toHaveBeenCalledWith(EMPTY.file);
    // A saved file may have edited a running forward's rule: that window's forwards are marked.
    expect(NO_FORWARD.hostsChanged).toHaveBeenCalledWith(window);
  });
  it('forward.* calls act for the sending window', async () => {
    const forward = {
      list: vi.fn(() => []),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      stopAll: vi.fn(() => Promise.resolve()),
      freePort: vi.fn(() => Promise.resolve(5433)),
      hostsChanged: vi.fn(() => Promise.resolve()),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
    const window = { id: 7 };
    expect(await invokeAs(window, 'forward.list', {})).toEqual({ ok: true, value: { forwards: [] } });
    expect(forward.list).toHaveBeenCalledWith(window);
    await invokeAs(window, 'forward.start', { hostId: 'a', ruleId: 'pg', port: 15432 });
    expect(forward.start).toHaveBeenCalledWith(window, { hostId: 'a', ruleId: 'pg', port: 15432 });
    await invokeAs(window, 'forward.stop', { hostId: 'a', ruleId: 'pg' });
    expect(forward.stop).toHaveBeenCalledWith(window, 'a', 'pg');
    await invokeAs(window, 'forward.stopAll', {});
    expect(forward.stopAll).toHaveBeenCalledWith(window);
    expect(await invokeAs(window, 'forward.freePort', { near: 5432 })).toEqual({ ok: true, value: { port: 5433 } });
  });
  it('ssh.secretNames answers names and where they live, never a value', async () => {
    const names = vi.fn().mockResolvedValue([{ name: 'DEPLOY_KEY', local: true, external: false }]);
    registerSshChannels({
      hosts: { list: vi.fn(), save: vi.fn() },
      secrets: { names, set: vi.fn() },
      ssh: NO_SSH,
      importer: NO_IMPORT,
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
        writeMany: vi.fn().mockReturnValue({ skipped: ['s2'] }),
        resize: vi.fn(),
        close: vi.fn(),
        trust: vi.fn().mockResolvedValue(undefined),
        knownHosts: vi.fn(),
        forgetHostKey: vi.fn(),
        hostOs: vi.fn(),
        setHostOs: vi.fn(),
        runSnippet: vi.fn(),
        previewSnippet: vi.fn(),
      };
      registerSshChannels({
        hosts: NO_HOSTS,
        secrets: NO_SECRETS,
        ssh,
        importer: NO_IMPORT,
        knownHostsImporter: NO_IMPORT,
        keys: NO_KEYS,
        sftp: NO_SFTP,
        snippets: NO_SNIPPETS,
        layouts: NO_LAYOUTS,
        forward: NO_FORWARD,
        sessionLogs: NO_SESSION_LOGS,
        transfers: NO_TRANSFERS,
        edits: NO_EDITS,
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
    it('ssh.writeMany', async () => {
      const ssh = register();
      const request = { sessionIds: ['s1', 's2'], data: 'aGk=' };
      expect(await invokeAs(window, 'ssh.writeMany', request)).toEqual({ ok: true, value: { skipped: ['s2'] } });
      expect(ssh.writeMany).toHaveBeenCalledWith(window, request);
    });
    it('ssh.writeMany refuses no ids and more than a tab holds', async () => {
      const ssh = register();
      const ids = Array.from({ length: 13 }, (_, i) => `s${String(i)}`);
      expect(await invokeAs(window, 'ssh.writeMany', { sessionIds: ids, data: 'aGk=' })).toMatchObject({ ok: false });
      expect(await invokeAs(window, 'ssh.writeMany', { sessionIds: [], data: 'aGk=' })).toMatchObject({ ok: false });
      expect(ssh.writeMany).not.toHaveBeenCalled();
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
    expect(await invoke('ssh.setHostOs', { host: 'box:22', os: 'beos' })).toMatchObject({ ok: false });
    expect(await invoke('ssh.setHostOs', { host: 'box:22', os: null, extra: 1 })).toMatchObject({ ok: false });
    expect(ssh.setHostOs).not.toHaveBeenCalled();
  });
});

describe('ssh snippet run channels', () => {
  it('run and preview for the calling window; a run can only turn Enter off', async () => {
    const runSnippet = vi.fn().mockResolvedValue(undefined);
    const previewSnippet = vi.fn().mockResolvedValue({ text: 'echo ••••', revision: 'r' });
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: { ...NO_SSH, runSnippet, previewSnippet },
      importer: NO_IMPORT,
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
    const window = { id: 7 };
    const request = { sessionId: 's1', snippetId: 'a', revision: 'r', values: { x: '1' }, bracketed: true };
    expect(await invokeAs(window, 'ssh.runSnippet', request)).toEqual({ ok: true, value: {} });
    expect(runSnippet).toHaveBeenCalledWith(window, request);
    expect(await invokeAs(window, 'ssh.runSnippet', { ...request, enter: true })).toMatchObject({ ok: false });
    expect(await invokeAs(window, 'ssh.runSnippet', { ...request, script: 'rm -rf ~' })).toMatchObject({ ok: false });
    expect(await invokeAs(window, 'ssh.previewSnippet', { snippetId: 'a', values: {} })).toEqual({
      ok: true,
      value: { text: 'echo ••••', revision: 'r' },
    });
    expect(previewSnippet).toHaveBeenCalledWith(window, { snippetId: 'a', values: {} });
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
    expect(await invoke('ssh.importPreview', { source: 'pick', path: '/etc/passwd' })).toMatchObject({ ok: false });
    expect(preview).not.toHaveBeenCalled();
  });

  it('known_hosts channels pass the calling window and refuse a path', async () => {
    const preview = vi.fn().mockResolvedValue({ cancelled: true });
    const apply = vi.fn().mockResolvedValue({ added: 0, replaced: 0, kept: 0 });
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      knownHostsImporter: { preview, apply },
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
    const window = { id: 7 };
    expect(await invokeAs(window, 'ssh.knownHostsImportPreview', { source: 'user-known-hosts' })).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    expect(preview).toHaveBeenCalledWith(window, { source: 'user-known-hosts' });
    const request = { previewId: 'p', replace: [{ host: 'a:22', keyType: 'ssh-ed25519' }] };
    await invokeAs(window, 'ssh.knownHostsImportApply', request);
    expect(apply).toHaveBeenCalledWith(window, request);
    expect(
      await invoke('ssh.knownHostsImportPreview', { source: 'pick', path: '/home/u/.ssh/known_hosts' }),
    ).toMatchObject({ ok: false });
    expect(preview).toHaveBeenCalledTimes(1);
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers,
      edits: NO_EDITS,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
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

  it('edit channels act for the sender, whose edits they are', async () => {
    const edits = {
      edit: vi.fn(() => Promise.resolve({ editId: 'e1' })),
      reply: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
    };
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers: NO_TRANSFERS,
      edits,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
    });
    const window = { id: 4 };
    const request = { sessionId: 's1', path: '/etc/app.conf', confirmedLarge: true };
    await expect(invokeAs(window, 'sftp.edit', request)).resolves.toEqual({ ok: true, value: { editId: 'e1' } });
    expect(edits.edit).toHaveBeenCalledWith(window, request);
    await expect(invokeAs(window, 'sftp.edit', { ...request, content: 'x' })).resolves.toMatchObject({ ok: false });
    await expect(invokeAs(window, 'sftp.editReply', { editId: 'e1', decision: 'keep-remote' })).resolves.toEqual({
      ok: true,
      value: {},
    });
    expect(edits.reply).toHaveBeenCalledWith(window, { editId: 'e1', decision: 'keep-remote' });
    await invokeAs(window, 'sftp.endEdit', { editId: 'e1' });
    expect(edits.end).toHaveBeenCalledWith(window, { editId: 'e1' });
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
      knownHostsImporter: NO_IMPORT,
      keys,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
      snippets,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
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
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
      snippets: new SnippetsService({ treeDir: () => dir }),
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs: NO_SESSION_LOGS,
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

describe('session log channels', () => {
  const window = { id: 9 };
  function register(sessionLogs: Parameters<typeof registerSshChannels>[0]['sessionLogs']) {
    registerSshChannels({
      hosts: NO_HOSTS,
      secrets: NO_SECRETS,
      ssh: NO_SSH,
      importer: NO_IMPORT,
      knownHostsImporter: NO_IMPORT,
      keys: NO_KEYS,
      sftp: NO_SFTP,
      snippets: NO_SNIPPETS,
      layouts: NO_LAYOUTS,
      forward: NO_FORWARD,
      sessionLogs,
      transfers: NO_TRANSFERS,
      edits: NO_EDITS,
    });
  }

  it('act on the calling window’s workspace, and refuse when none is open', async () => {
    const logs = { ...NO_SESSION_LOGS.logs, list: vi.fn().mockResolvedValue([]) };
    const switches = {
      all: vi.fn().mockResolvedValue({ 'host:web': true }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceOf = vi.fn((sender: { id: number }) => (sender.id === 9 ? 'ws-1' : undefined));
    register({ ...NO_SESSION_LOGS, logs, switches, workspaceOf });
    expect(await invokeAs(window, 'sessionLog.switches', {})).toEqual({
      ok: true,
      value: { switches: { 'host:web': true } },
    });
    await invokeAs(window, 'sessionLog.setSwitch', { target: { kind: 'group', id: 'prod' }, on: null });
    expect(switches.set).toHaveBeenCalledWith('ws-1', { kind: 'group', id: 'prod' }, null);
    await invokeAs(window, 'sessionLog.list', { hostId: 'web' });
    expect(logs.list).toHaveBeenCalledWith('ws-1', 'web');
    expect(await invokeAs({ id: 3 }, 'sessionLog.list', { hostId: 'web' })).toMatchObject({
      ok: false,
      error: { code: 'workspace-not-open' },
    });
  });

  it('reveal the file main found for the log, never a path the renderer names', async () => {
    const logs = { ...NO_SESSION_LOGS.logs, pathOf: vi.fn().mockResolvedValue('/data/session-logs/ws-1/web/x.log') };
    const reveal = vi.fn();
    register({ ...NO_SESSION_LOGS, logs, reveal, workspaceOf: () => 'ws-1' });
    await invokeAs(window, 'sessionLog.reveal', { hostId: 'web', id: '20261013T183000Z-aaaaaaaa' });
    expect(logs.pathOf).toHaveBeenCalledWith('ws-1', 'web', '20261013T183000Z-aaaaaaaa');
    expect(reveal).toHaveBeenCalledWith('/data/session-logs/ws-1/web/x.log');
    expect(await invokeAs(window, 'sessionLog.reveal', { hostId: 'web', id: 'x', path: '/etc' })).toMatchObject({
      ok: false,
    });
  });
});
