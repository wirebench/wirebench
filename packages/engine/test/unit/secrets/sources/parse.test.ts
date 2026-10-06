// packages/engine/test/unit/secrets/sources/parse.test.ts
import { describe, expect, it } from 'vitest';
import {
  effectiveSecretSources,
  parseLocalSecretSources,
  parseSecretSource,
  parseSecretSources,
  serializeSecretSources,
} from '../../../../src/secrets/sources/parse.js';

describe('parseSecretSource', () => {
  it('accepts each kind with its required fields', () => {
    expect(parseSecretSource({ kind: 'vault', path: 'kv/app', field: 'password' })).toEqual({
      kind: 'vault',
      path: 'kv/app',
      field: 'password',
    });
    expect(parseSecretSource({ kind: 'aws', secretId: 'prod/api', jsonKey: 'key', region: 'eu-west-1' }).kind).toBe(
      'aws',
    );
    expect(parseSecretSource({ kind: 'gcp', secret: 'api-key' }).kind).toBe('gcp');
    expect(parseSecretSource({ kind: 'azure', vault: 'team-kv', name: 'api-key' }).kind).toBe('azure');
    expect(parseSecretSource({ kind: '1password', ref: 'op://Team/Signer/password' }).kind).toBe('1password');
    expect(parseSecretSource({ kind: 'keychain', service: 'wirebench-dev', account: 'me' }).kind).toBe('keychain');
  });

  it.each([
    [{ kind: 'vault', path: '-address=https://evil', field: 'x' }, 'path'],
    [{ kind: 'vault', path: 'kv/app', field: '--help' }, 'field'],
    [{ kind: 'aws', secretId: 'a', region: 'EU WEST' }, 'region'],
    [{ kind: '1password', ref: 'Team/Signer/password' }, 'ref'],
    [{ kind: 'keychain', service: 'a\nb', account: 'me' }, 'service'],
    [{ kind: 'gcp', secret: 'x'.repeat(513) }, 'secret'],
    [{ kind: 'azure', vault: '', name: 'n' }, 'vault'],
    [{ kind: 'aws', secretId: 'file:///etc/passwd' }, 'secretId'],
    [{ kind: 'aws', secretId: 'fileb://x' }, 'secretId'],
    [{ kind: 'aws', secretId: 'https://evil.example/x' }, 'secretId'],
    [{ kind: 'aws', secretId: 'http://x' }, 'secretId'],
  ])('refuses %j on field %s', (raw, field) => {
    const parsed = parseSecretSource(raw);
    expect(parsed.kind).toBe('invalid');
    expect(parsed.kind === 'invalid' && parsed.field).toBe(field);
  });

  it('accepts an aws secret name and a full ARN', () => {
    expect(parseSecretSource({ kind: 'aws', secretId: 'prod/api' }).kind).toBe('aws');
    expect(
      parseSecretSource({
        kind: 'aws',
        secretId: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/api-AbCdEf',
      }).kind,
    ).toBe('aws');
  });

  it('refuses an unknown kind, a missing field and an unknown field', () => {
    expect(parseSecretSource({ kind: 'shell', command: 'cat' }).kind).toBe('invalid');
    expect(parseSecretSource({ kind: 'vault', path: 'kv/app' }).kind).toBe('invalid');
    expect(parseSecretSource({ kind: 'vault', path: 'kv/app', field: 'f', address: 'x' }).kind).toBe('invalid');
    expect(parseSecretSource('vault').kind).toBe('invalid');
  });

  it('keeps the raw entry of an invalid one', () => {
    const raw = { kind: 'vault', path: '-x', field: 'f' };
    expect(parseSecretSource(raw)).toMatchObject({ kind: 'invalid', raw });
  });
});

describe('parseSecretSources', () => {
  it('keeps invalid entries and reports them, and refuses bad names', () => {
    const { sources, issues } = parseSecretSources({
      good: { kind: 'gcp', secret: 's' },
      bad: { kind: 'vault', path: '-x', field: 'f' },
      'not a name': { kind: 'gcp', secret: 's' },
    });
    expect(sources['good']?.kind).toBe('gcp');
    expect(sources['bad']?.kind).toBe('invalid');
    expect(sources['not a name']?.kind).toBe('invalid');
    expect(issues.map((issue) => issue.name).sort()).toEqual(['bad', 'not a name']);
  });

  it('reports a prototype name as invalid and never sets the prototype', () => {
    const raw: unknown = JSON.parse(
      '{"__proto__": {"kind":"gcp","secret":"s"}, "constructor": {"kind":"gcp","secret":"s"}}',
    );
    const { sources, issues } = parseSecretSources(raw);
    expect(issues.map((issue) => issue.name).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(sources, '__proto__')?.value).toMatchObject({ kind: 'invalid' });
    expect(Object.getPrototypeOf(sources)).toBe(Object.prototype);
  });

  it('treats an absent map as empty and a non-mapping as one issue', () => {
    expect(parseSecretSources(undefined)).toEqual({ sources: {}, issues: [] });
    expect(parseSecretSources(['x']).issues).toEqual([{ name: '', reason: 'secretSources must be a mapping' }]);
  });
});

describe('effectiveSecretSources', () => {
  it('lets a local entry replace a shared one and none unmap it', () => {
    const shared = parseSecretSources({ a: { kind: 'gcp', secret: 'a' }, b: { kind: 'gcp', secret: 'b' } }).sources;
    const local = parseLocalSecretSources({ a: { kind: '1password', ref: 'op://v/i/f' }, b: { kind: 'none' } }).sources;
    const effective = effectiveSecretSources(shared, local);
    expect(effective.get('a')).toEqual({ source: { kind: '1password', ref: 'op://v/i/f' }, origin: 'local' });
    expect(effective.has('b')).toBe(false);
  });

  it('refuses none in the shared map', () => {
    expect(parseSecretSources({ a: { kind: 'none' } }).sources['a']?.kind).toBe('invalid');
  });
});

describe('serializeSecretSources', () => {
  it('writes an invalid entry back as its raw value, keys sorted', () => {
    const raw = { kind: 'vault', path: '-x', field: 'f' };
    const { sources } = parseSecretSources({ z: { kind: 'gcp', secret: 's' }, a: raw });
    expect(Object.keys(serializeSecretSources(sources))).toEqual(['a', 'z']);
    expect(serializeSecretSources(sources)['a']).toEqual(raw);
  });
});
