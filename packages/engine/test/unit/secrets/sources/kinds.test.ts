import { describe, expect, it } from 'vitest';
import { argvFor, parseSourceOutput } from '../../../../src/secrets/sources/kinds.js';
import { withSource, secretSourceError } from '../../../../src/secrets/sources/errors.js';

describe('argvFor', () => {
  it('builds each kind', () => {
    expect(
      argvFor({ kind: 'vault', path: 'kv/app', field: 'password', mount: 'secret', namespace: 'team' }, 'linux'),
    ).toEqual({
      tool: 'vault',
      args: ['kv', 'get', '-field=password', '-mount=secret', '-namespace=team', 'kv/app'],
    });
    expect(argvFor({ kind: 'aws', secretId: 'prod/api', region: 'eu-west-1', profile: 'ci' }, 'linux')).toEqual({
      tool: 'aws',
      args: [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        'prod/api',
        '--query',
        'SecretString',
        '--output',
        'text',
        '--region',
        'eu-west-1',
        '--profile',
        'ci',
      ],
    });
    expect(argvFor({ kind: 'gcp', secret: 'api-key', project: 'p' }, 'linux')).toEqual({
      tool: 'gcloud',
      args: ['secrets', 'versions', 'access', 'latest', '--secret=api-key', '--project=p'],
    });
    expect(argvFor({ kind: 'azure', vault: 'team-kv', name: 'api-key' }, 'linux')).toEqual({
      tool: 'az',
      args: [
        'keyvault',
        'secret',
        'show',
        '--vault-name',
        'team-kv',
        '--name',
        'api-key',
        '--query',
        'value',
        '--output',
        'tsv',
      ],
    });
    expect(argvFor({ kind: '1password', ref: 'op://T/S/password' }, 'linux')).toEqual({
      tool: 'op',
      args: ['read', 'op://T/S/password'],
    });
    expect(argvFor({ kind: 'keychain', service: 's', account: 'a' }, 'darwin')).toEqual({
      tool: 'security',
      args: ['find-generic-password', '-s', 's', '-a', 'a', '-w'],
    });
    expect(argvFor({ kind: 'keychain', service: 's', account: 'a' }, 'linux')).toEqual({
      tool: 'secret-tool',
      args: ['lookup', 'service', 's', 'account', 'a'],
    });
  });

  it('refuses the keychain on Windows', () => {
    expect(() => argvFor({ kind: 'keychain', service: 's', account: 'a' }, 'win32')).toThrow(
      expect.objectContaining({ code: 'secret-source-unsupported' }) as unknown,
    );
  });
});

describe('parseSourceOutput', () => {
  it('trims exactly one trailing newline', () => {
    expect(parseSourceOutput({ kind: '1password', ref: 'op://a/b/c' }, 'v\n\n')).toBe('v\n');
    expect(parseSourceOutput({ kind: '1password', ref: 'op://a/b/c' }, 'v\r\n')).toBe('v');
    expect(parseSourceOutput({ kind: '1password', ref: 'op://a/b/c' }, ' v ')).toBe(' v ');
  });

  it('refuses empty output', () => {
    expect(() => parseSourceOutput({ kind: 'gcp', secret: 's' }, '\n')).toThrow(
      expect.objectContaining({ code: 'secret-source-failed' }) as unknown,
    );
  });

  it('picks a jsonKey member', () => {
    const source = { kind: 'aws', secretId: 's', jsonKey: 'key' } as const;
    expect(parseSourceOutput(source, '{"key":"v","other":"w"}\n')).toBe('v');
    for (const bad of ['[1]', '{"other":"w"}', '{"key":1}', 'not json']) {
      expect(() => parseSourceOutput(source, bad)).toThrow(
        expect.objectContaining({ code: 'secret-source-failed' }) as unknown,
      );
    }
  });

  it('never puts the output in the error', () => {
    let message = '';
    try {
      parseSourceOutput({ kind: 'aws', secretId: 's', jsonKey: 'key' }, '{"other":"hunter2-secret"}');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
  });
});

describe('withSource', () => {
  it('fills in the name and kind and keeps the code', () => {
    const error = withSource(
      secretSourceError('secret-source-failed', '', '', 'vault exited with code 2.'),
      'db',
      'vault',
    );
    expect(error).toMatchObject({ code: 'secret-source-failed', details: { name: 'db', kind: 'vault' } });
    expect(error.message).toBe('Secret "db": vault exited with code 2.');
  });
});
