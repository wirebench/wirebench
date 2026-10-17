/**
 * Scripts imported from another client run (script layers): an Insomnia, Bruno or Hoppscotch import arrives with
 * its scripts switched off, and once switched on a variable the first request's script sets is what
 * the second request sends.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importBruno } from '../../../src/import/bruno/import.js';
import { mapHoppscotch } from '../../../src/import/hoppscotch/convert.js';
import { parseHoppscotchCollections } from '../../../src/import/hoppscotch/parse.js';
import { mapInsomnia } from '../../../src/import/insomnia/map.js';
import { parseInsomnia } from '../../../src/import/insomnia/parse.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { apiFolders, apiRequests } from '../../../src/rest/model.js';
import type { RestApi } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { startTestRestServer } from '../../helpers/index.js';
import type { TestRestServer } from '../../helpers/index.js';

let rest: TestRestServer;
let dir: string;
const sandbox = createScriptSandbox();
const checker = createScriptChecker();

beforeAll(async () => {
  rest = await startTestRestServer({});
  dir = mkdtempSync(join(tmpdir(), 'wb-client-scripts-'));
});

afterAll(async () => {
  await rest.close();
  await sandbox.dispose();
  await checker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function insomniaExport(): string {
  const request = (name: string, sortKey: number, extra: Record<string, unknown>): Record<string, unknown> => ({
    name,
    method: 'GET',
    url: `${rest.url}/echo`,
    meta: { id: `req_${name}`, sortKey },
    ...extra,
  });
  return JSON.stringify({
    type: 'collection.insomnia.rest/5.0',
    name: 'Shop',
    collection: [
      request('Login', -2, { scripts: { afterResponse: "insomnia.environment.set('token', 'tok-7731');" } }),
      request('Use', -1, {
        headers: [{ name: 'X-Echo', value: 'placeholder' }],
        scripts: {
          afterResponse:
            "const sent = JSON.parse(insomnia.response.text()).headers; insomnia.test('sent the token', () => insomnia.expect(sent['x-echo']).to.eql('tok-7731'));",
        },
      }),
    ],
  });
}

function projectFrom(api: RestApi): Project {
  const project = {
    formatVersion: FORMAT_VERSION,
    id: 'proj-client-scripts',
    name: 'Client scripts',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    containers: { soap: [], rest: [api] },
    environments: [],
    keystores: [],
    sequences: [],
    mocks: [],
  } satisfies Project;
  return project;
}

function importProject(enable: boolean): Project {
  let n = 0;
  const mapped = mapInsomnia(parseInsomnia(insomniaExport()), { newId: () => `id${String((n += 1))}` });
  const api = mapped.collections[0]!.rest!;
  // A value a script sets is read as ${#Sequence#name}; an imported {{ _.name }} is not rewritten to it.
  for (const r of apiRequests(api)) {
    if (r.name === 'Use')
      (r as { headers: unknown }).headers = [{ name: 'X-Echo', value: '${#Sequence#token}', enabled: true }];
  }
  if (enable) {
    for (const r of apiRequests(api)) {
      if (r.scripts !== undefined) (r as { scripts: unknown }).scripts = { ...r.scripts, enabled: true };
    }
  }
  return projectFrom(api);
}

async function run(p: Project) {
  const { selected } = selectRequests(p, []);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    scripting: new RequestScripting({ sandbox, checker }),
  };
  return runRequests(selected, context);
}

describe('imported client scripts in a run', () => {
  it(
    'an imported Insomnia script, turned on, sets a variable the next request sends',
    { timeout: 30_000 },
    async () => {
      const result = await run(importProject(true));
      expect(result.requests).toHaveLength(2);
      expect(result.requests[1]!.assertions.map((a) => [a.label, a.outcome])).toEqual([['sent the token', 'passed']]);
    },
  );

  it('the same scripts as imported, still switched off, do not run', { timeout: 30_000 }, async () => {
    const result = await run(importProject(false));
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1]!.assertions).toEqual([]);
  });
});

const BRUNO_BASIC = fileURLToPath(new URL('../../../../../fixtures/bruno/crafted/basic', import.meta.url));

/** Writes `files` (relative POSIX path to text) under a fresh folder of `dir`, and returns it. */
function writeFolder(name: string, files: Record<string, string>): string {
  const root = join(dir, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** Turns on every script an import attached, at any level. */
function switchOn(api: RestApi): void {
  for (const holder of [...apiFolders(api), ...apiRequests(api)]) {
    if (holder.scripts !== undefined) (holder as { scripts: unknown }).scripts = { ...holder.scripts, enabled: true };
  }
}

async function brunoProject(root: string): Promise<{ project: Project; api: RestApi }> {
  let n = 0;
  const mapped = await importBruno({ kind: 'folder', path: root }, { newId: () => `b${String((n += 1))}` });
  const api = mapped.collections[0]!.rest!;
  return { project: projectFrom(api), api };
}

const outcomes = (r: { assertions: readonly { label: string; outcome: string }[] }): string[][] =>
  r.assertions.map((a) => [a.label, a.outcome]);

describe('imported Bruno scripts in a run', () => {
  it('an imported Bruno post script captures a value the next request sends', { timeout: 30_000 }, async () => {
    // The crafted collection, with its requests pointed at the test server's /echo and the two
    // references only an environment could fill (the collection's token, the path's {{userId}}) given values,
    // and the digest login, whose password is a secret, switched off.
    const root = join(dir, 'bruno-basic');
    cpSync(BRUNO_BASIC, root, { recursive: true });
    const edit = (rel: string, change: (text: string) => string): void => {
      writeFileSync(join(root, rel), change(readFileSync(join(root, rel), 'utf8')));
    };
    edit('collection.bru', (t) => t.replace('{{process.env.TOKEN}}', 'literal-token'));
    for (const file of readdirSync(join(root, 'users'))) {
      edit(`users/${file}`, (t) =>
        t
          .replace(/^( {2}url: ).*$/m, `$1${rest.url}/echo`)
          // The echo has no `id`: capture the method it answers with instead.
          .replaceAll('res.body.id', 'res.body.method')
          // The echo answers 200 with the method, not 201 with the created user.
          .replaceAll('201', '200')
          .replace('res.body.name: Ada', 'res.body.method: POST')
          .replace('id: {{userId}}', 'id: 7')
          // Digest auth keeps its password as a secret, which a run has no store for.
          .replace('auth: digest', 'auth: none'),
      );
    }
    const { project, api } = await brunoProject(root);
    for (const r of apiRequests(api)) {
      if (r.name === 'Get user') {
        // A value a script sets is read as ${#Sequence#name}; an imported {{userId}} is not rewritten to it.
        (r as { headers: unknown }).headers = [{ name: 'X-Echo', value: '${#Sequence#userId}', enabled: true }];
        (r as { scripts: unknown }).scripts = {
          post: {
            text: "test('sent the captured id', function () { expect(res.body.headers['x-echo']).to.equal('POST'); });",
          },
          api: 'bruno',
          enabled: true,
          secrets: [],
        };
      }
      if (r.name === 'Create user') (r as { scripts: unknown }).scripts = { ...r.scripts, enabled: true };
    }
    const { selected } = selectRequests(project, []);
    const wanted = selected.filter((s) => ['Create user', 'Get user'].includes(s.request.name));
    const result = await runRequests(wanted, {
      project,
      projectDir: dir,
      overrides: {},
      host: { getSecret: () => Promise.resolve(undefined) },
      scripting: new RequestScripting({ sandbox, checker }),
    });
    expect(result.requests.map((r) => r.name)).toEqual(['Create user', 'Get user']);
    // The imported assertions and tests of the first request pass too, not left failing silently.
    expect(result.requests[0]!.assertions.map((a) => a.outcome)).toEqual(['passed', 'passed', 'passed']);
    expect(outcomes(result.requests[1]!)).toEqual([['sent the captured id', 'passed']]);
  });

  const collection = (extra: Record<string, string>): string =>
    writeFolder(`bruno-${String(Math.random()).slice(2)}`, {
      'bruno.json': JSON.stringify({ version: '1', name: 'order', type: 'collection' }),
      ...extra,
    });
  const get = (name: string, seq: number, blocks: string): string =>
    `meta {\n  name: ${name}\n  type: http\n  seq: ${String(seq)}\n}\n\nget {\n  url: ${rest.url}/echo\n  body: none\n  auth: none\n}\n\n${blocks}`;

  it(
    "with the API's scripts off, the request's post script runs before its folder's",
    { timeout: 30_000 },
    async () => {
      // A Bruno collection with no flow setting is a sandwich: the API holds only postResponseOrder
      // 'inner-first', and its level is not run.
      const root = collection({
        'f/folder.bru': [
          'meta {\n  name: F\n  seq: 1\n}\n',
          'script:post-response {',
          '  bru.setVar("order", (bru.getVar("order") || "") + "F");',
          '  test("the request ran first", function () { expect(bru.getVar("order")).to.equal("RF"); });',
          '}\n',
        ].join('\n'),
        'f/r.bru': get(
          'R',
          1,
          'script:post-response {\n  bru.setVar("order", (bru.getVar("order") || "") + "R");\n}\n',
        ),
      });
      const { project, api } = await brunoProject(root);
      expect(api.scripts).toMatchObject({ postResponseOrder: 'inner-first' });
      switchOn(api);
      (api as { scripts: unknown }).scripts = { ...api.scripts, enabled: false };
      const { selected } = selectRequests(project, []);
      const result = await runRequests(selected, {
        project,
        projectDir: dir,
        overrides: {},
        host: { getSecret: () => Promise.resolve(undefined) },
        scripting: new RequestScripting({ sandbox, checker }),
      });
      expect(result.requests).toHaveLength(1);
      expect(outcomes(result.requests[0]!)).toEqual([['the request ran first', 'passed']]);
    },
  );

  it(
    'runs a .jsonSchema assertion through the real worker: a matching body passes, a mismatch fails',
    { timeout: 30_000 },
    async () => {
      const root = collection({
        'ok.bru': get(
          'Ok',
          1,
          'tests {\n  test("matches", function () { expect(res.body).to.have.jsonSchema({ type: "object", required: ["method"] }); });\n}\n',
        ),
        'bad.bru': get(
          'Bad',
          2,
          'tests {\n  test("mismatches", function () { expect(res.body).to.have.jsonSchema({ type: "object", required: ["nope"] }); });\n}\n',
        ),
      });
      const { project, api } = await brunoProject(root);
      switchOn(api);
      const { selected } = selectRequests(project, []);
      const result = await runRequests(selected, {
        project,
        projectDir: dir,
        overrides: {},
        host: { getSecret: () => Promise.resolve(undefined) },
        scripting: new RequestScripting({ sandbox, checker }),
      });
      expect(result.requests.map((r) => outcomes(r))).toEqual([[['matches', 'passed']], [['mismatches', 'failed']]]);
    },
  );
});

describe('imported Hoppscotch scripts in a run', () => {
  const hopRequest = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    v: '17',
    name,
    method: 'GET',
    endpoint: `${rest.url}/echo`,
    params: [],
    headers: [],
    body: { contentType: null, body: null },
    auth: { authType: 'inherit', authActive: true },
    preRequestScript: '',
    testScript: '',
    requestVariables: [],
    ...extra,
  });

  it('an imported Hoppscotch test passes against the echo server', { timeout: 30_000 }, async () => {
    const text = JSON.stringify({
      v: 12,
      name: 'Shop',
      folders: [],
      requests: [
        hopRequest('Login', { testScript: "hopp.env.set('token', 'tok-7731');" }),
        hopRequest('Use', {
          headers: [{ key: 'X-Echo', value: 'placeholder', active: true, description: '' }],
          testScript:
            "pw.test('sent the token', () => { pw.expect(pw.response.body.headers['x-echo']).toBe('tok-7731'); });",
        }),
      ],
    });
    let n = 0;
    const { collections, report } = parseHoppscotchCollections(text);
    const mapped = mapHoppscotch(collections, report, { newId: () => `h${String((n += 1))}` });
    const api = mapped.collections[0]!.rest!;
    // Attached switched off; a value a script sets is read as ${#Sequence#name}, not the imported <<name>>.
    expect(apiRequests(api).map((r) => r.scripts?.enabled)).toEqual([false, false]);
    for (const r of apiRequests(api)) {
      if (r.name === 'Use')
        (r as { headers: unknown }).headers = [{ name: 'X-Echo', value: '${#Sequence#token}', enabled: true }];
    }
    switchOn(api);
    const { selected } = selectRequests(projectFrom(api), []);
    const result = await runRequests(selected, {
      project: projectFrom(api),
      projectDir: dir,
      overrides: {},
      host: { getSecret: () => Promise.resolve(undefined) },
      scripting: new RequestScripting({ sandbox, checker }),
    });
    expect(result.requests.map((r) => r.name)).toEqual(['Login', 'Use']);
    expect(outcomes(result.requests[1]!)).toEqual([['sent the token', 'passed']]);
  });
});
