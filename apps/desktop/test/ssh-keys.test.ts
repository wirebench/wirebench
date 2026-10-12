// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { secretPseudoRef } from '@wirebench/engine';
import { generateKey } from '@wirebench/ssh';
import type { HopCredentials } from '@wirebench/ssh';
import { SshKeysService } from '../src/main/ssh-keys.js';

const sender = { id: 7 } as unknown as WebContents;

/** An in-memory keychain: the names listing and the window's getter read the same values. */
function keychain(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    secrets: {
      names: vi.fn(() =>
        Promise.resolve([...values.keys()].sort().map((name) => ({ name, local: true, external: false }))),
      ),
      set: vi.fn((name: string, value: string) => {
        values.set(name, value);
        return Promise.resolve();
      }),
    },
    getSecret: (ref: string) => Promise.resolve([...values].find(([name]) => secretPseudoRef(name) === ref)?.[1]),
  };
}

const HOPS: HopCredentials[] = [
  {
    address: 'h',
    port: 22,
    user: 'u',
    auth: { kind: 'password', password: 'pw' },
    keepAlive: 0,
    connectTimeout: 5,
  },
];

function service(
  chain: ReturnType<typeof keychain>,
  extra: Partial<ConstructorParameters<typeof SshKeysService>[0]> = {},
) {
  const verifier = vi.fn();
  const connector = {
    prepareHops: vi.fn(() => Promise.resolve(HOPS)),
    verifierFor: vi.fn(() => Promise.resolve(verifier)),
    refusalError: vi.fn((_sender: WebContents, error: unknown) => error),
  };
  const keys = new SshKeysService({
    secrets: chain.secrets,
    connector,
    secretsFor: () => chain.getSecret,
    defaultComment: () => 'me@machine',
    ...extra,
  });
  return { keys, connector, verifier };
}

// An encrypted key runs bcrypt (16 rounds) to make and again to open: slow on a loaded machine.
describe('SshKeysService.generate', { timeout: 30_000 }, () => {
  it('stores the private key and the passphrase as secrets and answers only the public half', async () => {
    const chain = keychain();
    const { keys } = service(chain);
    const answer = await keys.generate({ name: 'deploy', algorithm: 'ed25519', passphrase: 'pass phrase' });
    expect(answer).toMatchObject({
      name: 'deploy',
      locked: false,
      keyType: 'ssh-ed25519',
      passphraseSecret: 'deploy_passphrase',
    });
    expect(answer.publicKey).toMatch(/^ssh-ed25519 \S+ me@machine$/);
    expect(chain.values.get('deploy')).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(chain.values.get('deploy_passphrase')).toBe('pass phrase');
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain('PRIVATE KEY');
    expect(wire).not.toContain('pass phrase');
  });

  it('stores no passphrase secret without a passphrase, and keeps a given comment', async () => {
    const chain = keychain();
    const { keys } = service(chain);
    const answer = await keys.generate({ name: 'k', algorithm: 'ecdsa', bits: 384, comment: ' ci bot ' });
    expect(answer.keyType).toBe('ecdsa-sha2-nistp384');
    expect(answer.publicKey?.endsWith(' ci bot')).toBe(true);
    expect([...chain.values.keys()]).toEqual(['k']);
    expect(answer.passphraseSecret).toBeUndefined();
  });

  it('refuses a name already taken, or whose _passphrase is, and stores nothing', async () => {
    const chain = keychain({ taken: 'pw', other_passphrase: 'x' });
    const { keys } = service(chain);
    await expect(keys.generate({ name: 'taken', algorithm: 'ed25519' })).rejects.toMatchObject({
      code: 'ssh-secret-exists',
    });
    await expect(keys.generate({ name: 'other', algorithm: 'ed25519', passphrase: 'p' })).rejects.toMatchObject({
      code: 'ssh-secret-exists',
      details: { name: 'other_passphrase' },
    });
    expect(chain.secrets.set).not.toHaveBeenCalled();
  });

  it('turns a refused size into a WirebenchError and stores nothing', async () => {
    const chain = keychain();
    const { keys } = service(chain);
    await expect(keys.generate({ name: 'k', algorithm: 'rsa', bits: 1024 })).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-key-invalid',
    });
    expect(chain.secrets.set).not.toHaveBeenCalled();
  });
});

describe('SshKeysService.keys', () => {
  it('lists the secrets holding private keys by their public half; a key without its passphrase is locked', async () => {
    const plain = await generateKey({ algorithm: 'ed25519', comment: 'plain' });
    const locked = await generateKey({ algorithm: 'ed25519', passphrase: 'p' });
    const opened = await generateKey({ algorithm: 'ed25519', passphrase: 'q' });
    const chain = keychain({
      a_password: 'hunter2',
      plain: plain.privateKey,
      locked: locked.privateKey,
      opened: opened.privateKey,
      opened_passphrase: 'q',
    });
    const { keys } = service(chain);
    const listed = await keys.keys(sender);
    expect(listed).toEqual([
      { name: 'locked', locked: true },
      {
        name: 'opened',
        locked: false,
        keyType: 'ssh-ed25519',
        fingerprint: opened.fingerprint,
        publicKey: opened.publicKey,
        passphraseSecret: 'opened_passphrase',
      },
      {
        name: 'plain',
        locked: false,
        keyType: 'ssh-ed25519',
        fingerprint: plain.fingerprint,
        publicKey: plain.publicKey,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain('hunter2');
  }, 30_000);
});

describe('SshKeysService.install', () => {
  it('signs in as the host does now and installs the public half', async () => {
    const key = await generateKey({ algorithm: 'ed25519' });
    const chain = keychain({ k: key.privateKey });
    const install = vi.fn(() => Promise.resolve('added' as const));
    const { keys, connector, verifier } = service(chain, { install });
    expect(await keys.install(sender, { secret: 'k', hostId: 'web' })).toEqual({ result: 'added' });
    expect(connector.prepareHops).toHaveBeenCalledWith(sender, 'web');
    expect(install).toHaveBeenCalledWith({ hops: HOPS, verifyHostKey: verifier, publicKey: key.publicKey });
  });

  it('refuses a secret that is not a key or not on this machine before any network', async () => {
    const chain = keychain({ pw: 'hunter2' });
    const install = vi.fn();
    const { keys, connector } = service(chain, { install });
    await expect(keys.install(sender, { secret: 'pw', hostId: 'web' })).rejects.toMatchObject({
      code: 'ssh-key-invalid',
    });
    await expect(keys.install(sender, { secret: 'gone', hostId: 'web' })).rejects.toMatchObject({
      code: 'secret-missing',
    });
    expect(connector.prepareHops).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('hands a refused connect to the connector, which names a new host key', async () => {
    const key = await generateKey({ algorithm: 'ed25519' });
    const chain = keychain({ k: key.privateKey });
    const refusal = Object.assign(new Error('untrusted'), { code: 'ssh-host-key-new' });
    const { keys, connector } = service(chain, { install: vi.fn(() => Promise.reject(refusal)) });
    await expect(keys.install(sender, { secret: 'k', hostId: 'web' })).rejects.toBe(refusal);
    expect(connector.refusalError).toHaveBeenCalledWith(sender, refusal);
  });
});
