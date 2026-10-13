import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import {
  SSH_KEY_BITS,
  describePrivateKey,
  describePublicKey,
  generateKey,
  looksLikePrivateKey,
} from '../../src/index.js';

const LINE = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}( .+)?$/;

// A pair as ssh2 1.17 makes it when the Ed25519 public key starts with a zero byte: the byte is dropped, so
// the key fields say 31 and 63 bytes and nothing reads the private key back. Made by ssh2, never used anywhere.
const SHORT_ED25519 = {
  private: [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMgAAAAtz',
    'c2gtZWQyNTUxOQAAAB+kOIHV2N2g4Ujjfrcg3Y/1BSolil0+DHGWXsuPI8vsAAAA',
    'iK5MdUKuTHVCAAAAC3NzaC1lZDI1NTE5AAAAH6Q4gdXY3aDhSON+tyDdj/UFKiWK',
    'XT4McZZey48jy+wAAAA/x1fexB9KqFEDGx5PFbHGd2f/ytDpDocW1daAJWCNYrWk',
    'OIHV2N2g4Ujjfrcg3Y/1BSolil0+DHGWXsuPI8vsAAAAAAECAwQFBgc=',
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n'),
  public: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAH6Q4gdXY3aDhSON+tyDdj/UFKiWKXT4McZZey48jy+w=',
};

// RSA and encrypted keys are CPU-bound (prime search, bcrypt): slow on a loaded machine.
describe('generateKey', { timeout: 30_000 }, () => {
  it('makes an Ed25519 key in OpenSSH format, with its public line and fingerprint', async () => {
    const key = await generateKey({ algorithm: 'ed25519', comment: 'me@laptop' });
    expect(key.privateKey).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(key.keyType).toBe('ssh-ed25519');
    expect(key.publicKey).toMatch(LINE);
    expect(key.publicKey.endsWith(' me@laptop')).toBe(true);
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // The private half describes to the same public key.
    expect(describePrivateKey(key.privateKey)).toEqual({
      keyType: key.keyType,
      fingerprint: key.fingerprint,
      publicKey: key.publicKey,
    });
  });

  it('throws away an Ed25519 pair whose public key lost its leading zero byte and makes another', async () => {
    expect(() => describePrivateKey(SHORT_ED25519.private)).toThrow(
      expect.objectContaining({ code: 'ssh-key-invalid' }),
    );
    const make = vi.spyOn(ssh2.utils, 'generateKeyPair').mockImplementationOnce((...args: unknown[]) => {
      const done = args.at(-1) as (error: Error | null, keys: typeof SHORT_ED25519) => void;
      done(null, SHORT_ED25519);
    });
    try {
      const key = await generateKey({ algorithm: 'ed25519' });
      expect(make).toHaveBeenCalledTimes(2);
      expect(key.publicKey).not.toBe(SHORT_ED25519.public);
      expect(describePrivateKey(key.privateKey).publicKey).toBe(key.publicKey);
    } finally {
      make.mockRestore();
    }
  });

  it.each([
    [256, 'ecdsa-sha2-nistp256'],
    [384, 'ecdsa-sha2-nistp384'],
    [521, 'ecdsa-sha2-nistp521'],
  ])('makes ECDSA %i', async (bits, type) => {
    const key = await generateKey({ algorithm: 'ecdsa', bits });
    expect(key.keyType).toBe(type);
    expect(describePrivateKey(key.privateKey).fingerprint).toBe(key.fingerprint);
  });

  it('makes RSA at the smallest offered size (the larger ones are only slower)', async () => {
    const key = await generateKey({ algorithm: 'rsa', bits: 2048 });
    expect(key.keyType).toBe('ssh-rsa');
    expect(describePrivateKey(key.privateKey).publicKey).toBe(key.publicKey);
  });

  it('defaults to the first offered size', () => {
    expect(SSH_KEY_BITS.rsa[0]).toBe(4096);
    expect(SSH_KEY_BITS.ecdsa[0]).toBe(256);
  });

  it('encrypts the key with a passphrase: without it, or with a wrong one, the key is locked', async () => {
    const key = await generateKey({ algorithm: 'ed25519', passphrase: 'correct horse' });
    expect(() => describePrivateKey(key.privateKey)).toThrow(
      expect.objectContaining({ code: 'ssh-key-locked', message: 'This private key needs its passphrase' }),
    );
    expect(() => describePrivateKey(key.privateKey, 'wrong')).toThrow(
      expect.objectContaining({ code: 'ssh-key-locked' }),
    );
    expect(describePrivateKey(key.privateKey, 'correct horse').publicKey).toBe(key.publicKey);
  });

  it('refuses a size the algorithm does not offer, an unknown type and a two-line comment', async () => {
    await expect(generateKey({ algorithm: 'rsa', bits: 1024 })).rejects.toMatchObject({ code: 'ssh-key-invalid' });
    await expect(generateKey({ algorithm: 'ecdsa', bits: 4096 })).rejects.toMatchObject({ code: 'ssh-key-invalid' });
    await expect(generateKey({ algorithm: 'dsa' as 'rsa' })).rejects.toMatchObject({ code: 'ssh-key-invalid' });
    await expect(generateKey({ algorithm: 'ed25519', comment: 'a\nb' })).rejects.toMatchObject({
      code: 'ssh-key-invalid',
    });
  });
});

describe('describePrivateKey', () => {
  it('reads a PEM key made elsewhere (PKCS#1 RSA)', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    expect(looksLikePrivateKey(privateKey)).toBe(true);
    expect(describePrivateKey(privateKey).keyType).toBe('ssh-rsa');
  });

  it('refuses a password and never repeats it', () => {
    expect(looksLikePrivateKey('hunter2')).toBe(false);
    let caught: unknown;
    try {
      describePrivateKey('hunter2');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'ssh-key-invalid' });
    expect(JSON.stringify(caught) + String((caught as Error).message)).not.toContain('hunter2');
  });

  it('refuses a broken key', () => {
    expect(() =>
      describePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'),
    ).toThrow(expect.objectContaining({ code: 'ssh-key-invalid' }));
  });
});

describe('describePublicKey', () => {
  it('keeps the comment, trims the line and refuses a type that does not match the blob', async () => {
    const key = await generateKey({ algorithm: 'ed25519', comment: "o'brien laptop" });
    expect(describePublicKey(`  ${key.publicKey}\n`).publicKey).toBe(key.publicKey);
    const blob = key.publicKey.split(' ')[1] ?? '';
    expect(() => describePublicKey(`ssh-rsa ${blob}`)).toThrow(expect.objectContaining({ code: 'ssh-key-invalid' }));
    expect(() => describePublicKey('not a key')).toThrow(expect.objectContaining({ code: 'ssh-key-invalid' }));
    expect(() => describePublicKey(`${key.publicKey}\nssh-ed25519 ${blob}`)).toThrow(
      expect.objectContaining({ code: 'ssh-key-invalid' }),
    );
  });
});
