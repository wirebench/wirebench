import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES, ConfigError, describeConfig, loadConfig } from '../../../src/config.js';
import { hintOf, open, seal } from '../../../src/hooks/secret-box.js';
import { hooksSettings } from '../../../src/hooks/settings.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};
const VARIABLE = 'WIREBENCH_SERVER_HOOKS_SECRET_KEY';
const KEY_TEXT = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const KEY = Buffer.alloc(32, 7);
const SECRET = 'abc123def456ghi789';

describe('WIREBENCH_SERVER_HOOKS_SECRET_KEY (§3.1)', () => {
  it('is optional, secret and documented', () => {
    expect(CONFIG_VARIABLES.find((variable) => variable.env === VARIABLE)).toMatchObject({
      key: 'hooksSecretKey',
      required: false,
      secret: true,
    });
    expect(hooksSettings(loadConfig(required, 't')).secretKey).toBeUndefined();
  });

  it('decodes 32 bytes into the hooks settings', () => {
    expect(hooksSettings(loadConfig({ ...required, [VARIABLE]: KEY_TEXT }, 't')).secretKey).toEqual(KEY);
  });

  it.each(['BwcHBwcHBwcHBwcHBwcHBw==', 'not base64 at all', `${KEY_TEXT.slice(0, -1)}AAAA=`])(
    'stops start-up for a key that is not 32 bytes of base64, never echoing it (%#)',
    (value) => {
      let caught: unknown;
      try {
        loadConfig({ ...required, [VARIABLE]: value }, 't');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).problems).toEqual([
        { variable: VARIABLE, message: 'must be 32 bytes, base64-encoded' },
      ]);
      expect((caught as ConfigError).message).not.toContain(value);
      expect(describeConfig({ ...required, [VARIABLE]: value }).find((row) => row.variable === VARIABLE)?.status).toBe(
        'invalid',
      );
    },
  );
});

describe('secret-box (§3.1)', () => {
  it('seals as version ‖ iv ‖ tag ‖ ciphertext (known answer)', () => {
    expect(seal(KEY, SECRET, Buffer.alloc(12, 1)).toString('hex')).toBe(
      '01010101010101010101010101fb452e3409398ea867df0aba4cd4a4571783ea86a28c886bb7e0e917175f190690c2',
    );
  });

  it('round-trips under a fresh IV each time', () => {
    const first = seal(KEY, SECRET);
    const second = seal(KEY, SECRET);
    expect(first.equals(second)).toBe(false);
    expect(first.length).toBe(1 + 12 + 16 + SECRET.length);
    expect(first.includes(Buffer.from(SECRET))).toBe(false);
    expect(open(KEY, first)).toBe(SECRET);
    expect(open(KEY, second)).toBe(SECRET);
  });

  it('throws on a wrong key, a changed byte, and a short or unknown box', () => {
    const sealed = seal(KEY, SECRET);
    expect(() => open(Buffer.alloc(32, 9), sealed)).toThrow();
    const changed = Buffer.from(sealed);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
    expect(() => open(KEY, changed)).toThrow();
    expect(() => open(KEY, sealed.subarray(0, 20))).toThrow('sealed secret');
    const other = Buffer.from(sealed);
    other.writeUInt8(2, 0);
    expect(() => open(KEY, other)).toThrow('sealed secret');
  });

  it('hints the last four characters of a secret of eight or more', () => {
    expect(hintOf(SECRET)).toBe('i789');
    expect(hintOf('abcdefgh')).toBe('efgh');
    expect(hintOf('short12')).toBeNull();
  });
});
