import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpFileError } from '../../../../src/errors.js';
import { parseHttpEnvFiles } from '../../../../src/rest/http-file/env.js';

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(rel: string): string {
  return readFileSync(resolve(here, '../../../../../../fixtures', rel), 'utf8');
}

describe('parseHttpEnvFiles', () => {
  it('merges public and private files; private values become secrets; $shared goes to project properties', () => {
    const plan = parseHttpEnvFiles(
      readFixture('http-file/crafted/http-client.env.json'),
      readFixture('http-file/crafted/http-client.private.env.json'),
      'project',
    );
    expect(plan.environments.map((e) => e.name)).toEqual(['dev', 'prod']);
    const dev = new Map(plan.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('host')).toEqual({ name: 'host', value: 'http://localhost:8080', enabled: true, secret: false });
    expect(dev.get('user')).toEqual({
      name: 'user',
      value: '',
      enabled: true,
      secret: true,
      secretValue: 'dev-private',
    });
    expect(dev.get('password')).toEqual({
      name: 'password',
      value: '',
      enabled: true,
      secret: true,
      secretValue: 'pw',
    });
    expect(dev.has('SSLConfiguration')).toBe(false);
    expect(plan.projectProperties?.variables).toEqual([{ name: 'version', value: 'v1', enabled: true, secret: false }]);
    expect(plan.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('SSLConfiguration')]));
  });

  it('sends $shared to workspace properties when imported on its own', () => {
    const plan = parseHttpEnvFiles('{"$shared":{"a":"1"},"dev":{}}', undefined, 'workspace-properties');
    expect(plan.workspaceProperties?.variables.map((v) => v.name)).toEqual(['a']);
    expect(plan.projectProperties).toBeUndefined();
  });

  it('imports a credential-named public literal as a secret, and says so', () => {
    const plan = parseHttpEnvFiles('{"dev":{"apiKey":"abc","token":"{{other}}","host":"h"}}', undefined, 'project');
    const dev = new Map(plan.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('apiKey')).toEqual({ name: 'apiKey', value: '', enabled: true, secret: true, secretValue: 'abc' });
    expect(dev.get('token')?.secret).toBe(false);
    expect(dev.get('token')?.value).toBe('${other}');
    expect(plan.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('apiKey')]));
    expect(plan.report.warnings.join('\n')).toContain('token');
    expect(plan.report.warnings.join('\n')).not.toContain('apiKey');
  });

  it('applies the credential rule and private precedence to $shared', () => {
    const plan = parseHttpEnvFiles(
      '{"$shared":{"apiKey":"abc","host":"h","token":"pub"}}',
      '{"$shared":{"token":"priv","password":"pw"}}',
      'project',
    );
    const shared = new Map(plan.projectProperties!.variables.map((v) => [v.name, v]));
    expect(shared.get('apiKey')).toEqual({
      name: 'apiKey',
      value: '',
      enabled: true,
      secret: true,
      secretValue: 'abc',
    });
    expect(shared.get('token')).toEqual({ name: 'token', value: '', enabled: true, secret: true, secretValue: 'priv' });
    expect(shared.get('password')?.secretValue).toBe('pw');
    expect(shared.get('host')?.secret).toBe(false);
    expect(plan.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('$shared: "apiKey"')]));
  });

  it('reads environments that only the private file has', () => {
    const plan = parseHttpEnvFiles('{"dev":{}}', '{"stage":{"password":"p"}}', 'project');
    expect(plan.environments.map((e) => e.name)).toEqual(['dev', 'stage']);
  });

  it('throws on malformed JSON and on a non-object root', () => {
    expect(() => parseHttpEnvFiles('{', undefined, 'project')).toThrow(HttpFileError);
    try {
      parseHttpEnvFiles('[]', undefined, 'project');
      expect.unreachable();
    } catch (error) {
      expect((error as HttpFileError).code).toBe('http-env-not-environments');
    }
    try {
      parseHttpEnvFiles(undefined, 'nope', 'project');
      expect.unreachable();
    } catch (error) {
      expect((error as HttpFileError).code).toBe('http-env-malformed');
    }
  });
});
