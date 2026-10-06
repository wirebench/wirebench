import { describe, expect, it } from 'vitest';
import { parseSecretSources } from '../../../../src/secrets/sources/parse.js';
import { secretSourcesHash, sharedTrusted } from '../../../../src/secrets/sources/trust.js';

describe('secretSourcesHash', () => {
  it('ignores key order at every level and changes with any value', () => {
    const a = parseSecretSources({
      x: { kind: 'aws', secretId: 's', region: 'eu-west-1' },
      y: { kind: 'gcp', secret: 'g' },
    }).sources;
    const b = parseSecretSources({
      y: { secret: 'g', kind: 'gcp' },
      x: { region: 'eu-west-1', secretId: 's', kind: 'aws' },
    }).sources;
    const c = parseSecretSources({
      x: { kind: 'aws', secretId: 's', region: 'eu-west-2' },
      y: { kind: 'gcp', secret: 'g' },
    }).sources;
    expect(secretSourcesHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(secretSourcesHash(a)).toBe(secretSourcesHash(b));
    expect(secretSourcesHash(a)).not.toBe(secretSourcesHash(c));
  });

  it('hashes an invalid entry by its raw value', () => {
    const a = parseSecretSources({ x: { kind: 'vault', path: '-a', field: 'f' } }).sources;
    const b = parseSecretSources({ x: { kind: 'vault', path: '-b', field: 'f' } }).sources;
    expect(secretSourcesHash(a)).not.toBe(secretSourcesHash(b));
  });

  it('has no hash for no mapping', () => {
    expect(secretSourcesHash(undefined)).toBeUndefined();
    expect(secretSourcesHash({})).toBeUndefined();
  });
});

describe('sharedTrusted', () => {
  it('follows each mode', () => {
    expect(sharedTrusted({ mode: 'approved', hash: 'h' }, 'h')).toBe(true);
    expect(sharedTrusted({ mode: 'approved', hash: 'h' }, 'k')).toBe(false);
    expect(sharedTrusted({ mode: 'approved', hash: undefined }, 'k')).toBe(false);
    expect(sharedTrusted({ mode: 'any' }, 'k')).toBe(true);
    expect(sharedTrusted({ mode: 'hash', hash: 'k' }, 'k')).toBe(true);
    expect(sharedTrusted({ mode: 'hash', hash: 'h' }, 'k')).toBe(false);
  });
});
