import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PostmanError } from '../../../../src/errors.js';
import * as engine from '../../../../src/index.js';
import {
  postmanVariablesOf,
  importPostmanVariables,
  isPostmanVariables,
  parsePostmanVariablesText,
} from '../../../../src/rest/postman/variables.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(here, '../../../../../../fixtures/postman/crafted/environment', name), 'utf8');

describe('parsePostmanVariablesText — environment', () => {
  const plan = parsePostmanVariablesText(fixture('staging.postman_environment.json'));
  const env = plan.environments[0]!;
  const byName = new Map(env.variables.map((v) => [v.name, v]));

  it('produces one environment named after the export', () => {
    expect(plan.environments).toHaveLength(1);
    expect(env.name).toBe('Staging');
    expect(plan.globals).toBeUndefined();
  });

  it('keeps plain values, rewrites {{x}} and honours enabled', () => {
    expect(byName.get('baseUrl')).toEqual({
      name: 'baseUrl',
      value: 'https://staging.example.com',
      enabled: true,
      secret: false,
    });
    expect(byName.get('legacy')).toEqual({ name: 'legacy', value: '${baseUrl}/v0', enabled: false, secret: false });
    expect(byName.get('retries')).toMatchObject({ value: '3', enabled: true });
  });

  it('carries a secret value only in secretValue', () => {
    expect(byName.get('apiToken')).toEqual({
      name: 'apiToken',
      value: '',
      enabled: true,
      secret: true,
      secretValue: 's3cr3t',
    });
    expect(byName.get('emptySecret')).toEqual({ name: 'emptySecret', value: '', enabled: true, secret: true });
  });

  it('reports what it skipped, kept as written, or noticed, and maps a dynamic variable', () => {
    expect(byName.has('nested')).toBe(false);
    expect(byName.get('requestId')).toMatchObject({ value: '${$guid}' });
    expect(plan.report.warnings.join('\n')).not.toContain('Dynamic variables');
    expect(plan.report.warnings).toEqual(
      expect.arrayContaining([
        'Staging: "nested" has a value that is not text, a number or true/false, so it was skipped.',
        'Staging: a variable with no name was skipped.',
        expect.stringContaining('sessionToken'),
      ]),
    );
    expect(plan.report.notes).toEqual(
      expect.arrayContaining(['Staging: "baseUrl" is defined more than once; the first value was kept.']),
    );
  });
});

describe('parsePostmanVariablesText — globals', () => {
  it('maps a globals export to the globals set', () => {
    const plan = parsePostmanVariablesText(fixture('workspace.postman_globals.json'));
    expect(plan.environments).toEqual([]);
    expect(plan.globals?.variables.map((v) => v.name)).toEqual(['tenant', 'signingKey']);
  });
});

describe('errors and detection', () => {
  it('refuses JSON that is not an environment or globals export', () => {
    expect(() => parsePostmanVariablesText('{"info":{"name":"x"},"item":[]}')).toThrow(PostmanError);
  });

  it('refuses a data dump with a message to export one by one', () => {
    expect(() => parsePostmanVariablesText('{"collections":[],"environments":[]}')).toThrow(/one by one/);
  });

  it('tells environment from globals, and treats a scope-less values+name object as an environment', () => {
    expect(isPostmanVariables({ values: [], _postman_variable_scope: 'globals' })).toBe('globals');
    expect(isPostmanVariables({ values: [], name: 'e' })).toBe('environment');
    expect(isPostmanVariables({ values: [] })).toBeUndefined();
  });
});

describe('importPostmanVariables', () => {
  it('reads text and file sources and is exported from the package', async () => {
    const text = fixture('workspace.postman_globals.json');
    const fromText = await importPostmanVariables({ kind: 'text', text });
    const fromFile = await importPostmanVariables({
      kind: 'file',
      path: resolve(here, '../../../../../../fixtures/postman/crafted/environment/workspace.postman_globals.json'),
    });
    expect(fromFile).toEqual(fromText);
    expect(engine.importPostmanVariables).toBe(importPostmanVariables);
    expect(engine.parsePostmanVariablesText).toBe(parsePostmanVariablesText);
    expect(engine.isPostmanVariables).toBe(isPostmanVariables);
  });
});

describe('postmanVariablesOf', () => {
  it('reads an already parsed export, the scope given when the document names none', () => {
    const doc = { name: 'Shared', values: [{ key: 'a', value: '1', enabled: true }] };
    expect(postmanVariablesOf(doc).environments.map((e) => e.name)).toEqual(['Shared']);
    expect(postmanVariablesOf(doc, 'globals').globals?.variables.map((v) => v.name)).toEqual(['a']);
    expect(postmanVariablesOf({ values: [] }, 'globals').globals?.name).toBe('Globals');
  });

  it('refuses a document without a values list, whatever the scope', () => {
    expect(() => postmanVariablesOf({ name: 'x' }, 'environment')).toThrow(PostmanError);
    expect(() => postmanVariablesOf({ values: [] })).toThrow(PostmanError);
    expect(() => postmanVariablesOf('text', 'globals')).toThrow(PostmanError);
  });
});
