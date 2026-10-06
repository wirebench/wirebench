import { describe, expect, it } from 'vitest';
import { parseSecretSources } from '../../../../src/secrets/sources/parse.js';
import { secretSourcesHash, sharedTrusted } from '../../../../src/secrets/sources/trust.js';

function withProto(value: unknown): Record<string, unknown> {
  const input: Record<string, unknown> = { a: { kind: 'gcp', secret: 's' } };
  Object.defineProperty(input, '__proto__', { value, enumerable: true, configurable: true, writable: true });
  return input;
}

describe('secretSourcesHash', () => {
  it('changes when an own __proto__ entry changes, at the top level and nested', () => {
    const top = (field: string) =>
      secretSourcesHash(parseSecretSources(withProto({ kind: 'vault', path: '-x', field })).sources);
    expect(top('f')).not.toBe(top('g'));
    const nested = (n: number) => {
      const raw: Record<string, unknown> = { kind: 'vault', path: '-x', field: 'f' };
      Object.defineProperty(raw, '__proto__', { value: { n }, enumerable: true, configurable: true, writable: true });
      return secretSourcesHash(parseSecretSources({ b: raw }).sources);
    };
    expect(nested(1)).not.toBe(nested(2));
  });

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
