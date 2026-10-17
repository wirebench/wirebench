import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deviceSignatureAlgorithm,
  deviceSignatureBlob,
  ecdsaP256Blob,
  encodeDeviceKey,
  isDeviceKeySecret,
  parseDeviceKey,
  publicKeyLine,
  sshRsaBlobFromSpki,
} from '../../src/device-key.js';
import type { DeviceKey } from '../../src/device-key.js';
import { describePrivateKey, looksLikeKeySecret } from '../../src/keygen.js';
import { fingerprintOf } from '../../src/known-hosts.js';
import { SshReader } from '../../src/sk-key.js';

function p256(): { key: DeviceKey; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const point = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  return {
    key: {
      platform: 'macos-secure-enclave',
      device: 'work-laptop',
      publicKey: publicKeyLine(ecdsaP256Blob(point), 'me@work-laptop'),
      handle: Buffer.alloc(324, 7).toString('base64'),
    },
    privateKey,
  };
}

describe('device key blocks', () => {
  it('round-trips and describes its public half', () => {
    const { key } = p256();
    const text = encodeDeviceKey(key);
    expect(text.split('\n').every((l) => l.length <= 64)).toBe(true);
    expect(isDeviceKeySecret(text)).toBe(true);
    expect(looksLikeKeySecret(text)).toBe(true);
    const parsed = parseDeviceKey(text);
    expect(parsed).toMatchObject({ ...key, keyType: 'ecdsa-sha2-nistp256' });
    const info = describePrivateKey(text);
    expect(info.keyType).toBe('ecdsa-sha2-nistp256');
    expect(info.publicKey).toBe(key.publicKey);
    expect(info.fingerprint).toBe(fingerprintOf(parsed!.publicBlob));
  });

  it('is undefined for other text and refuses a bad block', () => {
    expect(parseDeviceKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----')).toBe(
      undefined,
    );
    const wrap = (value: unknown): string =>
      `-----BEGIN WIREBENCH DEVICE KEY-----\n${Buffer.from(JSON.stringify(value)).toString('base64')}\n-----END WIREBENCH DEVICE KEY-----`;
    const { key } = p256();
    expect(() => parseDeviceKey(wrap({ ...key, v: 2 }))).toThrow(/later Wirebench/);
    expect(() => parseDeviceKey(wrap({ ...key, v: 1, platform: 'linux-tpm' }))).toThrow(/does not know/);
    // A Windows Hello key is RSA: a P-256 key under that platform is refused.
    expect(() => parseDeviceKey(wrap({ ...key, v: 1, platform: 'windows-hello' }))).toThrow(/not a device key/);
    expect(() => parseDeviceKey(wrap({ ...key, v: 1, handle: '' }))).toThrow(/not a device key/);
    expect(() =>
      parseDeviceKey('-----BEGIN WIREBENCH DEVICE KEY-----\nnot json\n-----END WIREBENCH DEVICE KEY-----'),
    ).toThrow(/not a device key/);
  });
});

describe('device signatures', () => {
  it('turns P-256 r‖s into an SSH signature blob that verifies', () => {
    const { key, privateKey } = p256();
    const parsed = parseDeviceKey(encodeDeviceKey(key))!;
    const data = Buffer.from('session id and request');
    const pad = (n: Buffer): Buffer => Buffer.concat([Buffer.alloc(32), n]).subarray(-32);
    for (let i = 0; i < 20; i++) {
      const raw = sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      const outer = new SshReader(deviceSignatureBlob(parsed, raw));
      expect(outer.text()).toBe('ecdsa-sha2-nistp256');
      const inner = new SshReader(outer.string());
      const rs = Buffer.concat([pad(inner.string()), pad(inner.string())]);
      expect(rs.equals(raw)).toBe(true);
      expect(verify('sha256', data, { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, rs)).toBe(true);
    }
    expect(deviceSignatureAlgorithm(parsed)).toBe('ecdsa-sha2-nistp256');
    expect(() => deviceSignatureBlob(parsed, Buffer.alloc(63))).toThrow(/signature/);
  });

  it('makes an ssh-rsa key from an SPKI and signs as rsa-sha2-256', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const blob = sshRsaBlobFromSpki(publicKey.export({ format: 'der', type: 'spki' }));
    const reader = new SshReader(blob);
    expect(reader.text()).toBe('ssh-rsa');
    const jwk = publicKey.export({ format: 'jwk' });
    expect(reader.string().equals(Buffer.from(jwk.e!, 'base64url'))).toBe(true);
    const n = reader.string();
    expect(n[0]).toBe(0); // the top bit of a 2048-bit modulus is set: the mpint leads with a zero byte
    expect(n.subarray(1).equals(Buffer.from(jwk.n!, 'base64url'))).toBe(true);
    const key = parseDeviceKey(
      encodeDeviceKey({
        platform: 'windows-hello',
        device: 'desk',
        publicKey: publicKeyLine(blob, ''),
        handle: 'wb-1',
      }),
    )!;
    expect(deviceSignatureAlgorithm(key)).toBe('rsa-sha2-256');
    const raw = sign('sha256', Buffer.from('x'), privateKey);
    const out = new SshReader(deviceSignatureBlob(key, raw));
    expect(out.text()).toBe('rsa-sha2-256');
    expect(out.string().equals(raw)).toBe(true);
  });

  it('refuses a public key it cannot read', () => {
    expect(() => ecdsaP256Blob(Buffer.alloc(33, 2))).toThrow(/public key/);
    expect(() => sshRsaBlobFromSpki(Buffer.from('nope'))).toThrow(/public key/);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => sshRsaBlobFromSpki(publicKey.export({ format: 'der', type: 'spki' }))).toThrow(/public key/);
  });
});
