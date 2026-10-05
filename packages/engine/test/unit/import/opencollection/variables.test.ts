import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapOpenCollection } from '../../../../src/import/opencollection/map.js';
import { parseOpenCollection } from '../../../../src/import/opencollection/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures');

function readFixture(rel: string): string {
  return readFileSync(resolve(fixtureDir, rel), 'utf8');
}

function mapText(text: string) {
  return mapOpenCollection(parseOpenCollection(text));
}

const head = 'opencollection: "1.0.0"\ninfo:\n  name: Crafted\n';

describe('OpenCollection variables and scripts', () => {
  const m = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')));

  it('maps environments: a secret carries no value, a variant list uses the selected value', () => {
    const dev = m.variables.environments[0]!;
    expect(dev.name).toBe('dev');
    expect(dev.variables.find((v) => v.name === 'token')).toEqual({
      name: 'token',
      value: '',
      enabled: true,
      secret: true,
    });
    expect(dev.variables.find((v) => v.name === 'region')).toEqual({
      name: 'region',
      value: 'eu-west',
      enabled: true,
      secret: false,
    });
    expect(m.variables.report.notes).toContain('dev: "region" has several values; the selected one was used.');
  });

  it('maps collection and folder variables to project properties', () => {
    expect(m.variables.projectProperties?.variables.map((v) => v.name)).toEqual(['tenant']);
  });

  it('keeps scripts as files under imported-scripts and never on requests', () => {
    expect(m.scripts).toEqual([{ path: 'imported-scripts/pets/get user.tests.js', source: "test('ok', () => {});" }]);
    expect(m.rest?.folders[0]?.requests[1]).not.toHaveProperty('scripts');
    expect(m.report.notes).toContain(
      'Get User: the tests script was saved to imported-scripts/pets/get user.tests.js and is never run.',
    );
  });

  it('maps assertions onto the request and counts them', () => {
    expect(m.rest?.folders[0]?.requests[1]?.assertions).toEqual([
      { type: 'status', equals: 200 },
      { type: 'match', language: 'jsonpath', expression: '$.name', exists: true },
    ]);
    expect(m.counts).toMatchObject({ assertions: 2, assertionsSkipped: 0 });
  });

  it('keeps variable lines out of the mapping report, and mapping lines out of the variable report', () => {
    expect(m.report.notes.some((n) => n.startsWith('dev:'))).toBe(false);
    expect(m.variables.report.notes.some((n) => n.startsWith('Get User:'))).toBe(false);
  });
});

describe('OpenCollection environments', () => {
  it('imports a secret with a value as a secret value, and a credential-named literal as a secret', () => {
    const m = mapText(`${head}config:
  environments:
    - name: dev
      variables:
        - { name: apiPassword, value: "hunter2" }
        - { name: sealed, value: "s3cr3t", secret: true }
        - { name: authToken, value: "{{other}}" }
        - { name: sessionId, value: "{{$guid}}" }
        - { name: off, value: "x", disabled: true }
items: []
`);
    const dev = new Map(m.variables.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('apiPassword')).toEqual({
      name: 'apiPassword',
      value: '',
      enabled: true,
      secret: true,
      secretValue: 'hunter2',
    });
    expect(dev.get('sealed')).toEqual({
      name: 'sealed',
      value: '',
      enabled: true,
      secret: true,
      secretValue: 's3cr3t',
    });
    expect(dev.get('authToken')).toEqual({ name: 'authToken', value: '${other}', enabled: true, secret: false });
    expect(dev.get('sessionId')).toMatchObject({ value: '{{$guid}}', secret: false });
    expect(dev.get('off')).toMatchObject({ value: 'x', enabled: false });
    expect(m.variables.report.notes).toContain(
      'dev: "apiPassword" looks like a credential, so its value was imported as a secret rather than plain text.',
    );
    const plain = m.variables.environments.flatMap((e) => e.variables.filter((v) => !v.secret));
    expect(JSON.stringify(plain)).not.toContain('hunter2');
    expect(m.report.warnings).toContain('Dynamic variables are kept as written and not expanded: $guid');
  });

  it('cuts literal user info from a URL value, with a warning', () => {
    const m = mapText(`${head}config:
  environments:
    - name: dev
      variables:
        - { name: host, value: "https://u:SECRET9@h.example.com/v1" }
        - { name: refs, value: "https://{{u}}:{{p}}@h.example.com" }
items: []
`);
    const dev = new Map(m.variables.environments[0]!.variables.map((v) => [v.name, v]));
    expect(dev.get('host')).toMatchObject({ value: 'https://h.example.com/v1', secret: false });
    expect(dev.get('refs')?.value).toBe('https://${u}:${p}@h.example.com');
    expect(m.variables.report.warnings).toContain('dev: the credential in the URL of "host" was not imported.');
    expect(JSON.stringify(m)).not.toContain('SECRET9');
  });

  it('skips object values, reports extras, and numbers a repeated environment name', () => {
    const m = mapText(`${head}config:
  environments:
    - name: dev
      extends: base
      dotEnvFilePath: .env
      variables:
        - { name: obj, value: { a: 1 } }
        - { name: keep, value: 1 }
    - name: Dev
      variables: []
items: []
`);
    expect(m.variables.environments.map((e) => e.name)).toEqual(['dev', 'Dev 2']);
    expect(m.variables.environments[0]!.variables).toEqual([
      { name: 'keep', value: '1', enabled: true, secret: false },
    ]);
    expect(m.variables.report.notes).toContain('dev: "obj" has an object value and was skipped.');
    expect(m.variables.report.warnings).toEqual(
      expect.arrayContaining([
        'dev: extends is not supported and was not imported.',
        'dev: dotEnvFilePath is not supported and was not imported.',
      ]),
    );
    expect(m.variables.report.notes).toContain(
      'An environment named "Dev" appears more than once in the collection, so this one was imported as "Dev 2".',
    );
  });

  it('warns once about a credential-looking name kept as a reference', () => {
    const m = mapText(`${head}config:
  environments:
    - name: dev
      variables:
        - { name: token, value: "{{t}}" }
items: []
`);
    expect(m.variables.report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('look like credentials but are not marked secret')]),
    );
  });
});

describe('OpenCollection project properties, request variables and config', () => {
  const m = mapText(`${head}config:
  proxy: { hostname: p }
request:
  variables:
    - { name: tenant, value: acme }
    - { name: off, value: x, disabled: true }
  scripts:
    - { type: before-request, code: "a()" }
items:
  - info: { name: Outer, type: folder }
    request:
      variables:
        - { name: tenant, value: other }
        - { name: region, value: "{{zone}}" }
      scripts:
        - { type: after-response, code: "b()" }
    items:
      - info: { name: Ping, type: http }
        http: { method: GET, url: "https://h/x" }
        runtime:
          variables:
            - { name: a, value: "1" }
            - { name: b, value: "2" }
          assertions:
            - { expression: res.status, operator: eq, value: "200", disabled: true }
            - { expression: res.headers.x, operator: eq, value: "1" }
            - { expression: res.body.id, operator: isNull }
  - info: { name: helpers }
    script: "module.exports = {};"
`);

  it('takes collection variables first, then folders in order, the first definition winning', () => {
    expect(m.variables.projectProperties?.variables).toEqual([
      { name: 'tenant', value: 'acme', enabled: true, secret: false },
      { name: 'off', value: 'x', enabled: false, secret: false },
      { name: 'region', value: '${zone}', enabled: true, secret: false },
    ]);
    expect(m.variables.report.notes).toContain(
      'Project properties: "tenant" is defined more than once (folder "Outer"); the first value was kept.',
    );
  });

  it('reports request variables and the config extras', () => {
    expect(m.report.warnings).toContain(
      'Ping: request-level variables (a, b) were not imported; Wirebench has no request scope.',
    );
    expect(m.report.warnings).toContain("The collection's proxy setting is not supported and was not imported.");
  });

  it('saves collection, folder and script-file scripts', () => {
    expect(m.scripts).toEqual([
      { path: 'imported-scripts/crafted/crafted.before-request.js', source: 'a()' },
      { path: 'imported-scripts/crafted/outer.after-response.js', source: 'b()' },
      { path: 'imported-scripts/crafted/helpers.module.js', source: 'module.exports = {};' },
    ]);
  });

  it('counts mapped and skipped assertions with a line for each one left out', () => {
    expect(m.rest?.folders[0]?.requests[0]?.assertions).toEqual([
      { type: 'match', language: 'jsonpath', expression: '$.id', exists: false },
    ]);
    expect(m.counts).toMatchObject({ assertions: 1, assertionsSkipped: 1 });
    expect(m.report.notes).toContain('Ping: a disabled assertion was skipped.');
    expect(m.report.warnings).toContain(
      'Ping: the assertion "res.headers.x eq 1" has no Wirebench equivalent and was not imported.',
    );
  });
});

describe('OpenCollection directory form', () => {
  it('reads environments from environments/*.yml, after config.environments, and an unreadable file', () => {
    const files = new Map<string, string>([
      ['environments/dev.yml', readFixture('opencollection/crafted/tree/environments/dev.yml')],
      ['environments/broken.yml', 'a: [unclosed'],
      ['Users/get-user.yml', readFixture('opencollection/crafted/tree/Users/get-user.yml')],
    ]);
    const root = `${head}config:\n  environments:\n    - name: dev\n      variables: []\nitems_none: true\n`;
    const m = mapOpenCollection(parseOpenCollection(root, files));
    expect(m.variables.environments.map((e) => e.name)).toEqual(['dev', 'dev 2']);
    expect(m.report.warnings).toContain('environments/broken.yml could not be read and was skipped.');
    expect(m.scripts.map((s) => s.path)).toEqual(['imported-scripts/crafted/get user.tests.js']);
  });
});
