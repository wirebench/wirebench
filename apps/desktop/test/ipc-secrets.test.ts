import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels } from '../src/shared/ipc.js';
import { SecretStore, ShowSecretsFlag, TEAM_KEY_LABEL_PREFIX, type CryptoBackend } from '../src/main/secrets.js';
import { registerSecretsChannels } from '../src/main/ipc/secrets.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function fakeCrypto(): CryptoBackend {
  return {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
}

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

let dir: string;

beforeEach(() => {
  handlers.clear();
  dir = mkdtempSync(join(tmpdir(), 'wirebench-secrets-ipc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('secrets channels registry', () => {
  it('has no get channel', () => {
    expect((channels.secrets as Record<string, unknown>)['get']).toBeUndefined();
  });
});

describe('registerSecretsChannels', () => {
  it('registers no ipc handler for secrets.get', () => {
    const store = new SecretStore(dir, fakeCrypto());
    registerSecretsChannels(store, new ShowSecretsFlag());
    expect(handlers.has('secrets.get')).toBe(false);
  });

  it('set returns a ref and never echoes the value', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    registerSecretsChannels(store, new ShowSecretsFlag());

    const result = (await invoke('secrets.set', { value: 's3cret!' })) as { ok: true; value: { ref: string } };
    expect(result.ok).toBe(true);
    expect(result.value.ref).toMatch(/^sec_/);
    expect(JSON.stringify(result)).not.toContain('s3cret!');
  });

  it('replace/exists/delete/list round trip through IPC', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    registerSecretsChannels(store, new ShowSecretsFlag());

    const setResult = (await invoke('secrets.set', { value: 'first', label: 'db' })) as {
      value: { ref: string };
    };
    const ref = setResult.value.ref;
    const replaced = await invoke('secrets.replace', { ref, value: 'second' });
    expect(replaced).toMatchObject({ ok: true, value: { ref } });

    expect(await invoke('secrets.exists', { ref })).toMatchObject({ ok: true, value: { exists: true } });
    const listed = (await invoke('secrets.list', undefined)) as { ok: true; value: { entries: { ref: string }[] } };
    expect(listed.value.entries.map((e) => e.ref)).toContain(ref);

    expect(await invoke('secrets.delete', { ref })).toMatchObject({ ok: true, value: { deleted: true } });
    expect(await invoke('secrets.exists', { ref })).toMatchObject({ ok: true, value: { exists: false } });
  });

  it('leaves team secrets machine-only entries out of list, and refuses to replace or delete them', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    registerSecretsChannels(store, new ShowSecretsFlag());
    const key = await store.set('{"private":"k"}', { label: `${TEAM_KEY_LABEL_PREFIX}ws-1` });

    const listed = (await invoke('secrets.list', undefined)) as { ok: true; value: { entries: { ref: string }[] } };
    expect(listed.value.entries.map((e) => e.ref)).not.toContain(key);
    expect(await invoke('secrets.delete', { ref: key })).toMatchObject({
      ok: false,
      error: { code: 'secret-machine-only' },
    });
    expect(await invoke('secrets.replace', { ref: key, value: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'secret-machine-only' },
    });
    expect(await store.getMachineOnly(key)).toBe('{"private":"k"}');
  });

  it('refuses to set a value under a machine-only label, so the renderer cannot plant a fake machine key', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    registerSecretsChannels(store, new ShowSecretsFlag());

    expect(await invoke('secrets.set', { value: 'x', label: `${TEAM_KEY_LABEL_PREFIX}ws-1` })).toMatchObject({
      ok: false,
      error: { code: 'secret-machine-only' },
    });
    expect(await store.findByLabel(`${TEAM_KEY_LABEL_PREFIX}ws-1`)).toBeUndefined();
  });

  it('setShowSecrets toggles the injected flag', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const flag = new ShowSecretsFlag();
    registerSecretsChannels(store, flag);

    expect(flag.get()).toBe(false);
    const result = await invoke('secrets.setShowSecrets', { show: true });
    expect(result).toMatchObject({ ok: true, value: { show: true } });
    expect(flag.get()).toBe(true);
  });

  it('getShowSecrets reads the flag back', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const flag = new ShowSecretsFlag();
    registerSecretsChannels(store, flag);

    expect(await invoke('secrets.getShowSecrets', undefined)).toMatchObject({ ok: true, value: { show: false } });
    flag.set(true);
    expect(await invoke('secrets.getShowSecrets', undefined)).toMatchObject({ ok: true, value: { show: true } });
  });
});
