// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRETS_FILE, SecretStore, type CryptoBackend } from '../src/main/secrets.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Reversible fake crypto (prefixes with `enc:`) so tests never touch the real OS keychain. */
function fakeCrypto(available = true): CryptoBackend {
  return {
    available,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
}

function fileText(): string {
  return readFileSync(join(dir, SECRETS_FILE), 'utf8');
}

describe('SecretStore', () => {
  it('sets a secret and returns a sec_ prefixed ref, never the value, in the file', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const ref = await store.set('hunter2');
    expect(ref).toMatch(/^sec_[a-f0-9]{26}$/);
    expect(await store.get(ref)).toBe('hunter2');
    expect(fileText()).not.toContain('hunter2');
  });

  it('replaces a value while keeping the same ref', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const ref = await store.set('first', { label: 'db' });
    const replaced = await store.replace(ref, 'second');
    expect(replaced).toBe(ref);
    expect(await store.get(ref)).toBe('second');
    const [entry] = await store.list();
    expect(entry?.label).toBe('db');
  });

  it('exists/delete round trip', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const ref = await store.set('v');
    expect(await store.exists(ref)).toBe(true);
    expect(await store.delete(ref)).toBe(true);
    expect(await store.exists(ref)).toBe(false);
    expect(await store.get(ref)).toBeUndefined();
    expect(await store.delete(ref)).toBe(false);
  });

  it('list() never carries values', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    await store.set('secret-value', { label: 'basic auth' });
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('secret-value');
    expect(entries[0]?.label).toBe('basic auth');
  });

  it('persists across instances (round trip through the file)', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const ref = await store.set('persisted');
    const reopened = new SecretStore(dir, fakeCrypto());
    expect(await reopened.get(ref)).toBe('persisted');
  });

  it('falls back to unencrypted storage (flagged) when encryption is unavailable, and warns once', async () => {
    const warnings: string[] = [];
    const store = new SecretStore(dir, fakeCrypto(false), (message) => warnings.push(message));
    const ref = await store.set('a');
    await store.set('b');
    expect(await store.get(ref)).toBe('a');
    const parsed = JSON.parse(fileText()) as { version: number; entries: Record<string, { encrypted: boolean }> };
    expect(parsed.version).toBe(2);
    expect(Object.values(parsed.entries).every((entry) => !entry.encrypted)).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('keeps earlier entries readable when keyring availability changes between writes', async () => {
    const unavailable = new SecretStore(dir, fakeCrypto(false), () => undefined);
    const plainRef = await unavailable.set('plain-value');

    // A later session finds the keyring available: the new entry is encrypted, the old one
    // must keep its own `encrypted: false` flag rather than being relabelled by a file-global one.
    const available = new SecretStore(dir, fakeCrypto(true));
    const encryptedRef = await available.set('encrypted-value');

    expect(await available.get(plainRef)).toBe('plain-value');
    expect(await available.get(encryptedRef)).toBe('encrypted-value');

    const reopened = new SecretStore(dir, fakeCrypto(true));
    expect(await reopened.get(plainRef)).toBe('plain-value');
    expect(await reopened.get(encryptedRef)).toBe('encrypted-value');
  });

  it('migrates a v1 file by applying its file-global encrypted flag to every entry', async () => {
    const { writeFileSync } = await import('node:fs');
    const v1 = {
      version: 1,
      encrypted: true,
      entries: {
        sec_one: {
          value: Buffer.from('enc:one', 'utf8').toString('base64'),
          createdAt: '2026-01-01T00:00:00.000Z',
          label: 'db',
        },
      },
    };
    writeFileSync(join(dir, SECRETS_FILE), JSON.stringify(v1), 'utf8');

    const store = new SecretStore(dir, fakeCrypto(true));
    expect(await store.get('sec_one')).toBe('one');
    const [entry] = await store.list();
    expect(entry?.label).toBe('db');

    // The migration is persisted on the next write.
    await store.set('two');
    const parsed = JSON.parse(fileText()) as { version: number; entries: Record<string, { encrypted: boolean }> };
    expect(parsed.version).toBe(2);
    expect(parsed.entries['sec_one']?.encrypted).toBe(true);
  });

  it('serialises concurrent writes so neither is lost', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    const [refA, refB] = await Promise.all([store.set('a'), store.set('b')]);
    expect(await store.get(refA)).toBe('a');
    expect(await store.get(refB)).toBe('b');
    const reopened = new SecretStore(dir, fakeCrypto());
    expect(await reopened.get(refA)).toBe('a');
    expect(await reopened.get(refB)).toBe('b');
  });

  it('treats a malformed file as empty rather than failing to start', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, SECRETS_FILE), 'not json', 'utf8');
    const store = new SecretStore(dir, fakeCrypto());
    expect(await store.list()).toEqual([]);
  });
});
