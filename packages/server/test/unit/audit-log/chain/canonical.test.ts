import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FIXED_ROW } from '../../../helpers/audit-chain.js';
import { canonicalBytes, genesisHash, keyId, link } from '../../../../src/audit-log/chain/canonical.js';

const KEY = 'test-chain-key-0123456789abcdefghij';

const EXPECTED_CANONICAL =
  '26:01J9ZK3V8Q0000000000000001' +
  '27:2026-10-03T09:15:42.123456Z' +
  '4:user' +
  '2:U1' +
  '14:zoë@例え.jp' +
  '-1:' +
  '-1:' +
  '16:workspace.pushed' +
  '9:workspace' +
  '2:W1' +
  '2:W1' +
  '-1:' +
  '11:2001:db8::7' +
  '-1:' +
  '38:{"a": 1, "b": "ü", "z": [true, null]}';

// Computed once with this implementation, checked by hand below, then pinned.
const GENESIS_HEX = '800f54c462b8ff5b798c1a7bd0e8997b1c9c15230670e49855266f4c88f5e75b';
const LINK_1_HEX = '9487d760a9b39573e9f4df0f487465eada2baa99fed40268180a66b6a6ad9a40';

describe('the audit chain link (audit-chain spec §2, §3.2)', () => {
  it('writes every column in order as len:value in UTF-8 bytes, a null as -1:', () => {
    const bytes = canonicalBytes(FIXED_ROW);
    expect(bytes.toString('utf8')).toBe(EXPECTED_CANONICAL);
    // Multi-byte text counts bytes, not characters.
    expect(Buffer.byteLength('zoë@例え.jp')).toBe(14);
    expect('zoë@例え.jp'.length).toBe(9);
  });

  it('tells a null from an empty string', () => {
    const empty = canonicalBytes({ ...FIXED_ROW, teamId: '' });
    expect(empty.equals(canonicalBytes(FIXED_ROW))).toBe(false);
    expect(empty.toString('utf8')).toContain('2:W10:11:2001');
  });

  it('pins the genesis hash: HMAC-SHA256(key, "wirebench-audit-chain-genesis")', () => {
    const byHand = createHmac('sha256', Buffer.from(KEY, 'utf8')).update('wirebench-audit-chain-genesis').digest('hex');
    expect(byHand).toBe(GENESIS_HEX);
    expect(genesisHash(KEY).toString('hex')).toBe(GENESIS_HEX);
  });

  it('pins a link: HMAC-SHA256(key, prev_hash ‖ seq as 8 bytes big-endian ‖ canonical row)', () => {
    const prev = Buffer.from(GENESIS_HEX, 'hex');
    const message = Buffer.concat([
      prev,
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
      Buffer.from(EXPECTED_CANONICAL, 'utf8'),
    ]);
    expect(createHmac('sha256', Buffer.from(KEY, 'utf8')).update(message).digest('hex')).toBe(LINK_1_HEX);
    expect(link(KEY, prev, 1n, FIXED_ROW).toString('hex')).toBe(LINK_1_HEX);
  });

  it('changes with the key, the previous hash, the seq and any column', () => {
    const prev = genesisHash(KEY);
    const base = link(KEY, prev, 1n, FIXED_ROW).toString('hex');
    expect(link(`${KEY}x`, prev, 1n, FIXED_ROW).toString('hex')).not.toBe(base);
    expect(link(KEY, Buffer.alloc(32), 1n, FIXED_ROW).toString('hex')).not.toBe(base);
    expect(link(KEY, prev, 2n, FIXED_ROW).toString('hex')).not.toBe(base);
    expect(
      link(KEY, prev, 1n, { ...FIXED_ROW, details: '{"a": 2, "b": "ü", "z": [true, null]}' }).toString('hex'),
    ).not.toBe(base);
  });

  it('refuses a previous hash that is not 32 bytes and a seq outside 1..2^63-1', () => {
    expect(() => link(KEY, Buffer.alloc(31), 1n, FIXED_ROW)).toThrow(RangeError);
    expect(() => link(KEY, genesisHash(KEY), 0n, FIXED_ROW)).toThrow(RangeError);
    expect(() => link(KEY, genesisHash(KEY), 2n ** 63n, FIXED_ROW)).toThrow(RangeError);
    expect(link(KEY, genesisHash(KEY), 2n ** 63n - 1n, FIXED_ROW)).toHaveLength(32);
  });

  it('keyId is the first 8 bytes of SHA-256(key), as 16 hex characters', () => {
    expect(keyId(KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyId(KEY)).toBe(createHash('sha256').update(KEY).digest('hex').slice(0, 16));
    expect(keyId(KEY)).toBe('900b9d516df2388a');
    expect(keyId(`${KEY}x`)).not.toBe(keyId(KEY));
  });
});
