import { describe, expect, it } from 'vitest';
import { checkKnownHost, parseKnownHosts, rememberKnownHost, serializeKnownHosts } from '../../src/index.js';

const a = { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaa' };

describe('known hosts', () => {
  it('new, known, changed', () => {
    expect(checkKnownHost([], a)).toBe('new');
    expect(checkKnownHost([a], a)).toBe('known');
    expect(checkKnownHost([a], { ...a, fingerprint: 'SHA256:bbb' })).toBe('changed');
    expect(checkKnownHost([a], { ...a, host: 'h:2222' })).toBe('new');
  });
  it('remember replaces the entry for the same host and key type', () => {
    expect(rememberKnownHost([a], { ...a, fingerprint: 'SHA256:bbb' })).toEqual([{ ...a, fingerprint: 'SHA256:bbb' }]);
  });
  it('round-trips and tolerates an empty or broken file', () => {
    expect(parseKnownHosts(serializeKnownHosts([a]))).toEqual([a]);
    expect(parseKnownHosts('')).toEqual([]);
    expect(parseKnownHosts('{not json')).toEqual([]);
    expect(parseKnownHosts('[{"host":1}]')).toEqual([]);
  });
});
