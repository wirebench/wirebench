import { createSecretMasker } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { maskerDetects } from '../../src/secret-advice.js';

describe('maskerDetects', () => {
  const password = 'p"ss\\w0rd-9f';
  const detects = maskerDetects(() => createSecretMasker([password]));

  it('detects the literal value', () => {
    expect(detects(`echo ${password}`)).toBe(true);
  });

  it('detects the JSON-escaped form the literal check missed', () => {
    expect(detects(`{"password":${JSON.stringify(password)}}`)).toBe(true);
  });

  it('detects a Basic credential carrying the value', () => {
    const basic = `Basic ${Buffer.from(`alice:${password}`).toString('base64')}`;
    expect(detects(`{"authorization":"${basic}"}`)).toBe(true);
  });

  it('is false for text without the secret, and sees secrets added later', () => {
    const known = [password];
    const live = maskerDetects(() => createSecretMasker(known));
    expect(live('{"ok":true}')).toBe(false);
    known.push('later-token-77');
    expect(live('x later-token-77')).toBe(true);
  });
});
