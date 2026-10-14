import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKey } from '../../src/keygen.js';
import {
  SK_ECDSA,
  SK_ED25519,
  SshReader,
  derToRs,
  encodeSkPrivateKey,
  isSkPrivateKey,
  parseSkPrivateKey,
  parseSkPublicBlob,
  skPublicBlob,
  skSignatureBlob,
} from '../../src/sk-key.js';
import type { SkKey } from '../../src/sk-key.js';

const ED_KEY: SkKey = {
  keyType: SK_ED25519,
  publicKey: Buffer.alloc(32, 0x11),
  application: 'ssh:',
  flags: 0x01,
  keyHandle: Buffer.alloc(48, 0x22),
  comment: 'me@laptop',
};
const EC_KEY: SkKey = {
  keyType: SK_ECDSA,
  // The P-256 generator point: ssh-keygen checks that the key lies on the curve.
  publicKey: Buffer.from(
    '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
    'hex',
  ),
  application: 'ssh:work',
  flags: 0x05,
  keyHandle: Buffer.alloc(64, 0x33),
  comment: '',
};

const hasSshKeygen = ((): boolean => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    // `-?` exits non-zero but proves it runs; only a missing binary is ENOENT.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
})();

describe('sk key format', () => {
  it('reads back what it writes, unencrypted and encrypted', { timeout: 30_000 }, () => {
    for (const key of [ED_KEY, EC_KEY]) {
      const plain = encodeSkPrivateKey(key);
      expect(isSkPrivateKey(plain)).toBe(true);
      expect(parseSkPrivateKey(plain)).toEqual(key);
      const sealed = encodeSkPrivateKey(key, 'correct horse');
      expect(isSkPrivateKey(sealed)).toBe(true);
      expect(parseSkPrivateKey(sealed, 'correct horse')).toEqual(key);
    }
  });

  it('asks for the passphrase of an encrypted key and refuses a wrong one', { timeout: 30_000 }, () => {
    const sealed = encodeSkPrivateKey(ED_KEY, 'right');
    expect(() => parseSkPrivateKey(sealed)).toThrow(expect.objectContaining({ code: 'ssh-key-locked' }));
    expect(() => parseSkPrivateKey(sealed, 'wrong')).toThrow(expect.objectContaining({ code: 'ssh-key-locked' }));
  });

  it('leaves other keys to ssh2: undefined for a non-sk OpenSSH key or a PEM key', async () => {
    const { privateKey } = await generateKey({ algorithm: 'ed25519' });
    expect(isSkPrivateKey(privateKey)).toBe(false);
    expect(parseSkPrivateKey(privateKey)).toBeUndefined();
    expect(parseSkPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).toBeUndefined();
  });

  it('reads the public blob and refuses a malformed sk blob', () => {
    expect(parseSkPublicBlob(skPublicBlob(EC_KEY))).toEqual({
      keyType: SK_ECDSA,
      publicKey: EC_KEY.publicKey,
      application: 'ssh:work',
    });
    const ssh = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.alloc(36)]);
    expect(parseSkPublicBlob(ssh)).toBeUndefined();
    const short = skPublicBlob(ED_KEY).subarray(0, 40);
    expect(() => parseSkPublicBlob(short)).toThrow(expect.objectContaining({ code: 'ssh-key-invalid' }));
  });

  it.runIf(hasSshKeygen)(
    'writes files OpenSSH reads: ssh-keygen -y prints the same public key',
    { timeout: 30_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-sk-'));
      try {
        for (const [key, passphrase] of [
          [ED_KEY, ''],
          [EC_KEY, 'pass phrase'],
        ] as const) {
          const file = join(dir, 'id_sk');
          writeFileSync(file, encodeSkPrivateKey(key, passphrase), { mode: 0o600 });
          const line = execFileSync('ssh-keygen', ['-y', '-P', passphrase, '-f', file], { encoding: 'utf8' });
          expect(line.trim().split(' ').slice(0, 2)).toEqual([key.keyType, skPublicBlob(key).toString('base64')]);
          rmSync(file);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('sk signature blob', () => {
  it('carries an Ed25519 signature raw, then the flags and counter', () => {
    const reader = new SshReader(skSignatureBlob(SK_ED25519, Buffer.alloc(64, 9), 0x05, 0x01020304));
    expect(reader.text()).toBe(SK_ED25519);
    expect(reader.string()).toEqual(Buffer.alloc(64, 9));
    expect(reader.byte()).toBe(0x05);
    expect(reader.uint32()).toBe(0x01020304);
    expect(reader.done).toBe(true);
  });

  it('turns an ECDSA DER signature into two mpints', () => {
    // r has its top bit set, so DER and the mpint both lead with a zero byte; s does not need one.
    const r = Buffer.concat([Buffer.from([0x00, 0x81]), Buffer.alloc(31, 1)]);
    const s = Buffer.concat([Buffer.from([0x7f]), Buffer.alloc(31, 2)]);
    const der = Buffer.concat([
      Buffer.from([0x30, 4 + r.length + s.length, 0x02, r.length]),
      r,
      Buffer.from([0x02, s.length]),
      s,
    ]);
    expect(derToRs(der)).toEqual({ r, s });
    const reader = new SshReader(skSignatureBlob(SK_ECDSA, der, 0x01, 7));
    expect(reader.text()).toBe(SK_ECDSA);
    const inner = new SshReader(reader.string());
    expect(inner.string()).toEqual(r);
    expect(inner.string()).toEqual(s);
    expect(reader.byte()).toBe(1);
    expect(reader.uint32()).toBe(7);
  });

  it('refuses a signature that is not DER', () => {
    expect(() => skSignatureBlob(SK_ECDSA, Buffer.from([1, 2, 3]), 1, 1)).toThrow(
      expect.objectContaining({ code: 'ssh-key-invalid' }),
    );
  });
});
