import { createHash, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor } from '../../src/fido/cbor.js';
import type { CborValue } from '../../src/fido/cbor.js';
import { skEnroll, skSign } from '../../src/fido/authenticator.js';
import { SK_ECDSA, SK_ED25519, SshReader, mpint } from '../../src/sk-key.js';
import type { SkKey } from '../../src/sk-key.js';
import { SoftAuthenticator, softTransport } from '../helpers/fido-authenticator.js';

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

/** What an OpenSSH server checks (PROTOCOL.u2f): sha256(application) ‖ flags ‖ counter ‖ sha256(data). */
function serverAccepts(authenticator: SoftAuthenticator, key: SkKey, data: Buffer, blob: Buffer): boolean {
  const reader = new SshReader(blob);
  if (reader.text() !== key.keyType) return false;
  const inner = reader.string();
  const flags = reader.byte();
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(reader.uint32());
  const message = Buffer.concat([sha256(key.application), Buffer.from([flags]), counter, sha256(data)]);
  const publicKey = authenticator.publicKeyOf(key.keyHandle);
  if (!publicKey) return false;
  if (key.keyType === SK_ED25519) return verify(null, message, publicKey, inner);
  const parts = new SshReader(inner);
  const fixed = (n: Buffer): Buffer => Buffer.concat([Buffer.alloc(32), n]).subarray(-32);
  const rs = Buffer.concat([fixed(parts.string()), fixed(parts.string())]);
  return verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, rs);
}

const enroll = async (
  authenticator: SoftAuthenticator,
  keyType: SkKey['keyType'],
  extra: { pin?: string; verifyRequired?: boolean; application?: string } = {},
): Promise<SkKey> => ({
  ...(await skEnroll({ keyType, transport: softTransport(authenticator), ...extra })),
  comment: '',
});

describe('cbor', () => {
  it('round-trips the CTAP2 subset', () => {
    const value = new Map<number | string, CborValue>([
      [1, 'ssh:'],
      [2, Buffer.from([1, 2, 3])],
      [-25, [true, false, null, 0, 23, 24, 255, 256, 65536, -1, -500]],
      ['up', new Map([['rk', false]])],
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it('refuses truncated or trailing input', () => {
    expect(() => decodeCbor(Buffer.from([0x62, 0x61]))).toThrow();
    expect(() => decodeCbor(Buffer.from([0x01, 0x02]))).toThrow();
  });
});

describe('security key enrol and sign', () => {
  for (const keyType of [SK_ED25519, SK_ECDSA] as const) {
    it(`makes a ${keyType} key and signs what a server accepts, waiting for a touch`, async () => {
      const authenticator = new SoftAuthenticator();
      const key = await enroll(authenticator, keyType);
      expect(key.application).toBe('ssh:');
      expect(key.flags).toBe(0x01);
      expect(key.publicKey.length).toBe(keyType === SK_ED25519 ? 32 : 65);
      const data = Buffer.from('session id and userauth request');
      const touched: string[] = [];
      const blob = await skSign(key, data, {
        transport: softTransport(authenticator),
        onTouch: () => touched.push('touch'),
      });
      expect(touched).toEqual(['touch']);
      expect(serverAccepts(authenticator, key, data, blob)).toBe(true);
      expect(serverAccepts(authenticator, key, Buffer.from('other data'), blob)).toBe(false);
    });
  }

  it('signs with the PIN when the key asks for it, under either PIN protocol', async () => {
    for (const pinProtocols of [[2, 1], [1]]) {
      const authenticator = new SoftAuthenticator({ pin: '1234', pinProtocols });
      const key = await enroll(authenticator, SK_ED25519, { pin: '1234', verifyRequired: true });
      expect(key.flags).toBe(0x05);
      const data = Buffer.from('data');
      const blob = await skSign(key, data, { pin: '1234', transport: softTransport(authenticator) });
      expect(serverAccepts(authenticator, key, data, blob)).toBe(true);
      // The user-verified flag rides in the signature: a server with verify-required checks it.
      const reader = new SshReader(blob);
      reader.text();
      reader.string();
      expect(reader.byte() & 0x04).toBe(0x04);
    }
  });

  it('refuses before touching the device when a verify-required key has no PIN', async () => {
    const authenticator = new SoftAuthenticator({ pin: '1234' });
    const key = await enroll(authenticator, SK_ED25519, { pin: '1234', verifyRequired: true });
    const before = authenticator.commands.length;
    await expect(skSign(key, Buffer.from('x'), { transport: softTransport(authenticator) })).rejects.toMatchObject({
      code: 'ssh-sk-pin',
      details: { reason: 'required' },
    });
    expect(authenticator.commands.length).toBe(before);
  });

  it('says how many attempts are left after a wrong PIN', async () => {
    const authenticator = new SoftAuthenticator({ pin: '1234' });
    const key = await enroll(authenticator, SK_ED25519, { pin: '1234', verifyRequired: true });
    await expect(
      skSign(key, Buffer.from('x'), { pin: '0000', transport: softTransport(authenticator) }),
    ).rejects.toMatchObject({ code: 'ssh-sk-pin', details: { reason: 'wrong', retries: 7 } });
  });

  it('asks for the PIN to enrol on an authenticator that has one set', async () => {
    const authenticator = new SoftAuthenticator({ pin: '1234' });
    await expect(enroll(authenticator, SK_ED25519)).rejects.toMatchObject({
      code: 'ssh-sk-pin',
      details: { reason: 'required' },
    });
    await expect(enroll(authenticator, SK_ED25519, { pin: '1234' })).resolves.toMatchObject({ flags: 0x01 });
  });

  it('refuses an algorithm the authenticator cannot make', async () => {
    const authenticator = new SoftAuthenticator({ algorithms: [-7] });
    await expect(enroll(authenticator, SK_ED25519)).rejects.toMatchObject({ code: 'ssh-sk-unavailable' });
  });

  it('tells a missing touch, a missing key and a U2F-only key apart', async () => {
    const holder = new SoftAuthenticator();
    const key = await enroll(holder, SK_ED25519);
    const untouched = new SoftAuthenticator({ touch: 'never' });
    for (const [id, credential] of holder.credentials) untouched.credentials.set(id, credential);
    await expect(skSign(key, Buffer.from('x'), { transport: softTransport(untouched) })).rejects.toMatchObject({
      code: 'ssh-sk-not-touched',
    });
    await expect(skSign(key, Buffer.from('x'), { transport: softTransport() })).rejects.toMatchObject({
      code: 'ssh-sk-no-device',
    });
    await expect(
      skSign(key, Buffer.from('x'), { transport: softTransport(new SoftAuthenticator()) }),
    ).rejects.toMatchObject({ code: 'ssh-sk-no-device' });
    await expect(
      skSign(key, Buffer.from('x'), { transport: softTransport(new SoftAuthenticator({ u2fOnly: true })) }),
    ).rejects.toMatchObject({ code: 'ssh-sk-unavailable' });
  });

  it('finds the key that holds the credential among several, touching only that one', async () => {
    const other = new SoftAuthenticator();
    const holder = new SoftAuthenticator();
    const key = await enroll(holder, SK_ECDSA);
    holder.touches = 0;
    const data = Buffer.from('data');
    const blob = await skSign(key, data, { transport: softTransport(other, holder) });
    expect(serverAccepts(holder, key, data, blob)).toBe(true);
    expect(holder.touches).toBe(1);
    expect(other.touches).toBe(0);
  });

  it('refuses to enrol with several keys plugged in', async () => {
    await expect(
      skEnroll({ keyType: SK_ED25519, transport: softTransport(new SoftAuthenticator(), new SoftAuthenticator()) }),
    ).rejects.toMatchObject({ code: 'ssh-sk-no-device', details: { reason: 'several' } });
  });

  it('frames a long message over continuation packets', async () => {
    // A 1 KB application name pushes each request well past one 64-byte report.
    const authenticator = new SoftAuthenticator();
    const key = await enroll(authenticator, SK_ED25519, { application: `ssh:${'a'.repeat(1000)}` });
    const data = Buffer.alloc(2000, 1);
    const blob = await skSign(key, data, { transport: softTransport(authenticator) });
    expect(serverAccepts(authenticator, key, data, blob)).toBe(true);
  });

  it('writes an mpint without a needless zero and with one for a high bit', () => {
    expect(mpint(Buffer.from([0, 0, 0x7f]))).toEqual(Buffer.from([0, 0, 0, 1, 0x7f]));
    expect(mpint(Buffer.from([0x80]))).toEqual(Buffer.from([0, 0, 0, 2, 0, 0x80]));
  });
});
