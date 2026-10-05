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

  it('imports a credential-named public value as a secret unless it is made of references alone', () => {
    const plan = parseHttpEnvFiles(
      '{"dev":{"password":"{{prefix}}hunter2","token":"{{other}}","apiKey":"{{login.response.body.k}}","sessionId":"{{$uuid}}"}}',
      undefined,
      'project',
    );
    const dev = new Map(plan.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('password')).toEqual({
      name: 'password',
      value: '',
      enabled: true,
      secret: true,
      secretValue: '${prefix}hunter2',
    });
    expect(dev.get('token')).toMatchObject({ value: '${other}', secret: false });
    expect(dev.get('apiKey')).toMatchObject({ value: '{{login.response.body.k}}', secret: false });
    expect(dev.get('sessionId')).toMatchObject({ value: '{{$uuid}}', secret: false });
    expect(JSON.stringify(plan.environments.map((e) => e.variables.filter((v) => !v.secret)))).not.toContain('hunter2');
  });

  it('cuts literal user info from public and $shared URLs, with a warning', () => {
    const plan = parseHttpEnvFiles(
      '{"$shared":{"base":"https://u:SECRET5@x.example.com/v1"},"dev":{"host":"https://u:SECRET6@h.example.com","auth_host":"u:SECRET7@h.example.com","refs":"https://{{u}}:{{p}}@h.example.com","mail":"bob@example.com"}}',
      undefined,
      'project',
    );
    const dev = new Map(plan.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('host')).toMatchObject({ value: 'https://h.example.com', secret: false });
    expect(dev.get('auth_host')?.secret).toBe(true);
    expect(dev.get('refs')?.value).toBe('https://${u}:${p}@h.example.com');
    expect(dev.get('mail')?.value).toBe('bob@example.com');
    expect(plan.projectProperties?.variables[0]).toMatchObject({ value: 'https://x.example.com/v1', secret: false });
    expect(plan.report.warnings).toContain('dev: the credential in the URL of "host" was not imported.');
    expect(plan.report.warnings).toContain('$shared: the credential in the URL of "base" was not imported.');
    const plain = [...plan.environments, plan.projectProperties!].flatMap((set) =>
      set.variables.filter((v) => !v.secret),
    );
    expect(JSON.stringify(plain)).not.toMatch(/SECRET[567]/);
    expect(JSON.stringify(plan.report)).not.toMatch(/SECRET[567]/);
  });

  it('cuts user info from a scheme-less authority', () => {
    const plan = parseHttpEnvFiles('{"dev":{"host":"u:SECRET8@h.example.com"}}', undefined, 'project');
    expect(plan.environments[0]!.variables[0]).toMatchObject({ value: 'h.example.com', secret: false });
  });

  it('rewrites templates in public and private values as @variables are rewritten', () => {
    const plan = parseHttpEnvFiles(
      '{"dev":{"url":"{{host}}/v1","home":"{{$processEnv HOME}}","id":"{{$uuid}}","next":"{{login.response.body.id}}"}}',
      '{"dev":{"password":"{{$processEnv PW}}","user":"{{name}}","chain":"{{login.response.body.t}}"}}',
      'project',
    );
    const dev = new Map(plan.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('url')?.value).toBe('${host}/v1');
    expect(dev.get('home')?.value).toBe('${#System#HOME}');
    expect(dev.get('id')?.value).toBe('{{$uuid}}');
    expect(dev.get('next')?.value).toBe('{{login.response.body.id}}');
    expect(dev.get('password')?.secretValue).toBe('${#System#PW}');
    expect(dev.get('user')?.secretValue).toBe('${name}');
    expect(plan.report.warnings).toContain('Dynamic variables are kept as written and not expanded: $uuid');
    expect(plan.report.warnings.join('\n')).toContain('{{login.response.body.id}}');
    expect(plan.report.warnings.join('\n')).not.toContain('{{login.response.body.t}}');
    expect(plan.report.warnings).toContain(
      '1 request-chaining reference(s) in http-client.private.env.json were kept as written and need a script or a property capture.',
    );
  });
});
