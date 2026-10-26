// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Caller } from '../src/main/host/platform.js';
import { asCaller } from './helpers/ipc-table.js';
import { secretPseudoRef } from '@wirebench/engine';
import { ecdsaP256Blob, encodeDeviceKey, generateKey, publicKeyLine } from '@wirebench/ssh';
import type { HopCredentials } from '@wirebench/ssh';
import { SoftAuthenticator, softTransport } from '@wirebench/ssh/test-helpers';
import { SshKeysService } from '../src/main/ssh-keys.js';

const sender = asCaller({ id: 7 });

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
    refusalError: vi.fn((_sender: Caller, error: unknown) => error),
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

describe('SshKeysService.generate with a security key (#420)', () => {
  it('makes the key on the authenticator with the PIN, stores the handle file and never the PIN', async () => {
    const authenticator = new SoftAuthenticator({ pin: '2468' });
    const chain = keychain();
    const { keys } = service(chain, {
      generate: (options) => generateKey({ ...options, transport: softTransport(authenticator) }),
    });
    const answer = await keys.generate({ name: 'yubi', algorithm: 'ed25519-sk', pin: '2468', verifyRequired: true });
    expect(answer).toMatchObject({ name: 'yubi', locked: false, keyType: 'sk-ssh-ed25519@openssh.com' });
    expect(answer.publicKey).toMatch(/^sk-ssh-ed25519@openssh\.com [A-Za-z0-9+/=]+ me@machine$/);
    expect(authenticator.credentials.size).toBe(1);
    expect([...chain.values.keys()]).toEqual(['yubi']);
    expect([...chain.values.values()].join('\n')).not.toContain('2468');
    // The keychain lists it by its public half, like any key.
    expect(await keys.keys(sender)).toEqual([answer]);
  });

  it('passes a security key refusal through as a WirebenchError and stores nothing', async () => {
    const chain = keychain();
    const { keys } = service(chain, {
      generate: (options) => generateKey({ ...options, transport: softTransport() }),
    });
    await expect(keys.generate({ name: 'yubi', algorithm: 'ecdsa-sk' })).rejects.toMatchObject({
      code: 'ssh-sk-no-device',
    });
    expect(chain.values.size).toBe(0);
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

describe('SshKeysService certificates (#421)', () => {
  // ssh-keygen-made test fixtures, shared with the ssh package's tests.
  const fixture = (name: string): string =>
    readFileSync(new URL(`../../../packages/ssh/test/fixtures/certs/${name}`, import.meta.url), 'utf8');

  it("lists a key's <name>_cert with its principals, validity window and key ID", async () => {
    const chain = keychain({ alice: fixture('user_ed25519'), alice_cert: fixture('user_ed25519-cert.pub') });
    const [key] = await service(chain).keys.keys(sender);
    expect(key?.certificate).toEqual({
      secret: 'alice_cert',
      keyId: 'alice@example',
      serial: '42',
      principals: ['alice', 'deploy'],
      validAfter: Date.parse('2020-01-01T00:00:00Z'),
      validBefore: Date.parse('2099-12-31T23:59:59Z'),
      window: 'from 2020-01-01 00:00:00 UTC to 2099-12-31 23:59:59 UTC',
      validity: 'valid',
      caFingerprint: 'SHA256:vB5oARcV1UTfAV+1JF6lo66WAGXVjH4Xx+b4lIQy4Ig',
      matchesKey: true,
    });
  });

  it('marks an expired certificate, one for another key, and a _cert secret that is not a certificate', async () => {
    const chain = keychain({
      a: fixture('user_ed25519'),
      a_cert: fixture('user_ed25519-expired-cert.pub'),
      b: fixture('user_ecdsa'),
      b_cert: fixture('user_ed25519-cert.pub'),
      c: fixture('user_rsa'),
      c_cert: 'hunter2',
    });
    const keys = await service(chain).keys.keys(sender);
    const byName = new Map(keys.map((k) => [k.name, k]));
    expect(byName.get('a')?.certificate).toMatchObject({ validity: 'expired', matchesKey: true });
    expect(byName.get('b')?.certificate).toMatchObject({ validity: 'valid', matchesKey: false });
    expect(byName.get('c')?.certificate).toBeUndefined();
    expect(byName.get('c')?.certificateError).toBe('c_cert is not an OpenSSH certificate');
    expect(JSON.stringify(keys)).not.toContain('hunter2');
  });

  it('attaches a certificate as <name>_cert, replacing an older one', async () => {
    const chain = keychain({ alice: fixture('user_ed25519'), alice_cert: fixture('user_ed25519-expired-cert.pub') });
    const answer = await service(chain).keys.attachCertificate(sender, {
      secret: 'alice',
      certificate: `  ${fixture('user_ed25519-cert.pub')}`,
    });
    expect(chain.values.get('alice_cert')).toBe(fixture('user_ed25519-cert.pub').trim());
    expect(answer).toMatchObject({ name: 'alice', certificate: { secret: 'alice_cert', validity: 'valid' } });
  });

  it('refuses a host certificate, one for another key, and text that is not a certificate, storing nothing', async () => {
    const chain = keychain({ alice: fixture('user_ed25519') });
    const { keys } = service(chain);
    const attach = (certificate: string) => keys.attachCertificate(sender, { secret: 'alice', certificate });
    await expect(attach(fixture('user_ed25519-host-cert.pub'))).rejects.toMatchObject({ code: 'ssh-cert-invalid' });
    await expect(attach(fixture('user_ecdsa-cert.pub'))).rejects.toMatchObject({ code: 'ssh-cert-mismatch' });
    await expect(attach(fixture('user_ed25519.pub'))).rejects.toMatchObject({ code: 'ssh-cert-invalid' });
    await expect(
      keys.attachCertificate(sender, { secret: 'nobody', certificate: fixture('user_ed25519-cert.pub') }),
    ).rejects.toMatchObject({ code: 'secret-missing' });
    expect(chain.secrets.set).not.toHaveBeenCalled();
  });
});

describe('device keys (#428)', () => {
  const point = (): Buffer =>
    generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  const block = (device: string): string =>
    encodeDeviceKey({
      platform: 'macos-secure-enclave',
      device,
      publicKey: publicKeyLine(ecdsaP256Blob(point()), 'me@machine'),
      handle: `handle-of-${device}`,
    });

  it('makes a device key, stores its block and no passphrase', async () => {
    const chain = keychain();
    const made = block('work-laptop');
    const deviceKeys = {
      status: vi.fn(),
      create: vi.fn(() => Promise.resolve(made)),
      isHere: vi.fn(() => Promise.resolve(true)),
    };
    const { keys } = service(chain, { deviceKeys });
    const key = await keys.generate({ name: 'id_ecdsa_device', algorithm: 'device', passphrase: 'ignored' });
    expect(deviceKeys.create).toHaveBeenCalledWith('me@machine');
    expect(chain.values.get('id_ecdsa_device')).toBe(made);
    expect(chain.values.has('id_ecdsa_device_passphrase')).toBe(false);
    expect(key).toMatchObject({
      name: 'id_ecdsa_device',
      keyType: 'ecdsa-sha2-nistp256',
      device: { platform: 'macos-secure-enclave', madeOn: 'work-laptop', here: true },
    });
    expect(key.passphraseSecret).toBeUndefined();
  });

  it('refuses a device key where the machine has none, storing nothing', async () => {
    const chain = keychain();
    const { keys } = service(chain);
    await expect(keys.generate({ name: 'id_ecdsa_device', algorithm: 'device' })).rejects.toMatchObject({
      code: 'ssh-device-key-unavailable',
    });
    expect(chain.values.size).toBe(0);
    await expect(keys.deviceKeyStatus()).resolves.toMatchObject({ supported: false });
  });

  it('lists device keys, telling this device’s from another’s', async () => {
    const chain = keychain({ mine: block('work-laptop'), theirs: block('other-mac'), note: 'plain text' });
    const isHere = vi.fn((key: { device: string }) => Promise.resolve(key.device === 'work-laptop'));
    const { keys } = service(chain, { deviceKeys: { status: vi.fn(), create: vi.fn(), isHere } });
    const listed = await keys.keys(sender);
    expect(listed.map((k) => [k.name, k.device])).toEqual([
      ['mine', { platform: 'macos-secure-enclave', madeOn: 'work-laptop', here: true }],
      ['theirs', { platform: 'macos-secure-enclave', madeOn: 'other-mac', here: false }],
    ]);
  });
});
