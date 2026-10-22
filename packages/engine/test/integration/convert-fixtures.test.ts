/**
 * The crafted fixtures end to end (convert spec §12, §15): each client's crafted collection is
 * imported, every level's scripts are switched on and sent layered against a local server, then
 * every level is converted, type-checked with the real checker, and sent again. Both sends must
 * record the same tests and values, and no fixture call may become a TODO. The Bruno collection's
 * `inner-first` order must survive conversion (§8).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from '#protocol-grpc/grpc/model';
import { ocOfBrunoFolder } from '../../src/import/bruno/convert.js';
import { importBruno, mapBruno, readBrunoFolder } from '../../src/import/bruno/import.js';
import type { MappedCollectionV3Entry } from '../../src/import/collection-v3/map.js';
import { importCollectionV3Folder } from '../../src/import/collection-v3/read-folder.js';
import { importHoppscotch } from '../../src/import/hoppscotch/import.js';
import { importInsomnia } from '../../src/import/insomnia/import.js';
import { importThunderClient } from '../../src/import/thunder/import.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '#core/project/model';
import type { Project } from '#core/project/model';
import { createProtocolRegistry } from '#core/protocol/registry';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import type { RestApi, RestFolder, RestRequestDef } from '#protocol-rest/rest/model';
import type { RunContext } from '#core/run/context';
import { runRequests } from '#core/run/run';
import { selectRequests } from '#core/run/select';
import { createScriptChecker } from '#core/script/check/host';
import { convertLevelScripts } from '#core/script/convert/index';
import type { ConvertTodo } from '#core/script/convert/index';
import type { ConvertProtocol } from '#core/script/convert/roots';
import type { RequestScripts, ScriptOutcome, ScriptPhase, ScriptValue } from '#core/script/model';
import { isLayeredApi } from '#core/script/model';
import { levelScriptTypes, RequestScripting } from '#core/script/request-scripts';
import { runScript } from '#core/script/run';
import { createScriptSandbox } from '#core/script/sandbox/host';
import { scriptDeclarations } from '#core/script/types/api';
import { GRPC } from '../unit/script/snapshots.js';

const fixture = (path: string): string => fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url));

/**
 * Every crafted fixture that carries scripts. The other crafted files (Postman v2.0/v2.1, the
 * `single` v3 folder, Insomnia's two-workspace export, Hoppscotch's mixed and GraphQL exports and
 * the older Thunder Client ones) hold none; the Postman dialect is covered by the v3 workspace.
 */
const FIXTURES: Readonly<Record<string, () => Promise<{ collections: readonly MappedCollectionV3Entry[] }>>> = {
  'postman-v3/workspace': () => importCollectionV3Folder(fixture('postman-v3/workspace')),
  'insomnia/crafted/v4.json': () => importInsomnia({ kind: 'file', path: fixture('insomnia/crafted/v4.json') }),
  'insomnia/crafted/v4.yaml': () => importInsomnia({ kind: 'file', path: fixture('insomnia/crafted/v4.yaml') }),
  'insomnia/crafted/v5-collection.yaml': () =>
    importInsomnia({ kind: 'file', path: fixture('insomnia/crafted/v5-collection.yaml') }),
  'bruno/crafted/basic': () => importBruno({ kind: 'folder', path: fixture('bruno/crafted/basic') }),
  'bruno/crafted/export.json': () => importBruno({ kind: 'file', path: fixture('bruno/crafted/export.json') }),
  'hoppscotch/crafted/v12-r17.json': () =>
    importHoppscotch({ kind: 'file', path: fixture('hoppscotch/crafted/v12-r17.json') }),
  'hoppscotch/crafted/legacy-v0.json': () =>
    importHoppscotch({ kind: 'file', path: fixture('hoppscotch/crafted/legacy-v0.json') }),
  'thunder-client/crafted/collection-1.2.json': () =>
    importThunderClient({ kind: 'file', path: fixture('thunder-client/crafted/collection-1.2.json') }),
};

// --- the local server ---------------------------------------------------------------------------------

/** What every fixture's scripts read: a created user, a product, and 201 for a POST. */
const BODY = { id: 'u-1', name: 'Ada', age: 5, data: { product: { name: 'Widget' } } };

let server: Server;
let serverUrl = '';
const sandbox = createScriptSandbox();
const checker = createScriptChecker();
const dir = mkdtempSync(join(tmpdir(), 'wb-convert-fixtures-'));
const registry = createProtocolRegistry(BUILTIN_PROTOCOLS, { features: [SCRIPTS_FEATURE] });

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const body = Buffer.from(JSON.stringify(BODY), 'utf8');
      response.writeHead(request.method === 'POST' ? 201 : 200, {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sandbox.dispose();
  await checker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// --- the levels ---------------------------------------------------------------------------------------

/** One level's scripts, where it sits, and its protocol. */
interface Level {
  readonly where: string;
  readonly protocol: ConvertProtocol;
  readonly scripts: RequestScripts;
}

type Rewrite = (scripts: RequestScripts, protocol: ConvertProtocol, where: string) => RequestScripts;

const withScripts = <T extends { readonly scripts?: RequestScripts }>(
  item: T,
  protocol: ConvertProtocol,
  where: string,
  rewrite: Rewrite,
): T => (item.scripts === undefined ? item : { ...item, scripts: rewrite(item.scripts, protocol, where) });

function rewriteRest(api: RestApi, rewrite: Rewrite): RestApi {
  const request = (r: RestRequestDef, at: string): RestRequestDef => withScripts(r, 'rest', `${at}/${r.name}`, rewrite);
  const folder = (f: RestFolder, at: string): RestFolder => {
    const here = `${at}/${f.name}`;
    return {
      ...withScripts(f, 'rest', here, rewrite),
      folders: f.folders.map((child) => folder(child, here)),
      requests: f.requests.map((r) => request(r, here)),
    };
  };
  return {
    ...withScripts(api, 'rest', api.name, rewrite),
    folders: api.folders.map((f) => folder(f, api.name)),
    requests: api.requests.map((r) => request(r, api.name)),
  };
}

function rewriteGrpc(api: GrpcApi, rewrite: Rewrite): GrpcApi {
  const request = (r: GrpcRequestDef, at: string): GrpcRequestDef => withScripts(r, 'grpc', `${at}/${r.name}`, rewrite);
  const folder = (f: GrpcFolder, at: string): GrpcFolder => {
    const here = `${at}/${f.name}`;
    return {
      ...withScripts(f, 'grpc', here, rewrite),
      folders: f.folders.map((child) => folder(child, here)),
      requests: f.requests.map((r) => request(r, here)),
    };
  };
  return {
    ...withScripts(api, 'grpc', api.name, rewrite),
    folders: api.folders.map((f) => folder(f, api.name)),
    requests: api.requests.map((r) => request(r, api.name)),
  };
}

/** Every level of the collections that holds a script, in tree order. */
function levelsOf(collections: readonly MappedCollectionV3Entry[]): Level[] {
  const levels: Level[] = [];
  const collect: Rewrite = (scripts, protocol, where) => {
    levels.push({ where, protocol, scripts });
    return scripts;
  };
  for (const c of collections) {
    if (c.rest !== undefined) rewriteRest(c.rest, collect);
    if (c.grpc !== undefined) rewriteGrpc(c.grpc, collect);
  }
  return levels;
}

/** `item` without `keys`. */
function without<T extends object, K extends keyof T>(item: T, ...keys: readonly K[]): Omit<T, K> {
  const copy: Partial<T> = { ...item };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

/** A level switched on, as written. */
const switchedOn: Rewrite = (scripts) => ({ ...scripts, enabled: true });

/** A level converted and switched on; `todos` collects what it left. */
function converted(todos: { where: string; todo: ConvertTodo }[]): Rewrite {
  return (scripts, protocol, where) => {
    if (!isLayeredApi(scripts.api)) throw new Error(`${where}: not an imported script`);
    const level = convertLevelScripts({
      dialect: scripts.api,
      protocol,
      ...(scripts.pre !== undefined ? { pre: scripts.pre.text } : {}),
      ...(scripts.post !== undefined ? { post: scripts.post.text } : {}),
      backups: {},
    });
    if (!level.ok) throw new Error(`${where}: line ${String(level.line)}: ${level.message}`);
    todos.push(...level.todos.map((todo) => ({ where, todo })));
    return {
      ...without(scripts, 'pre', 'post'),
      api: 'wirebench',
      enabled: true,
      ...(level.pre !== undefined ? { pre: { text: level.pre } } : {}),
      ...(level.post !== undefined ? { post: { text: level.post } } : {}),
    };
  };
}

// --- the send -----------------------------------------------------------------------------------------

/**
 * A REST API made to reach the local server: each request goes to `/<slug>` with the API's base
 * URL, and keeps its method, scripts and assertions. Its auth, headers, query, path parameters
 * and body are dropped: they reach for variables, files and credentials the fixtures do not carry,
 * and no fixture script reads them.
 */
function sendable(api: RestApi): RestApi {
  const request = (r: RestRequestDef): RestRequestDef => ({
    ...r,
    url: `/${r.slug}`,
    pathParams: [],
    query: [],
    headers: [],
    body: { kind: 'none' },
    auth: { type: 'none' },
  });
  const folder = (f: RestFolder): RestFolder => {
    return { ...without(f, 'auth'), folders: f.folders.map(folder), requests: f.requests.map(request) };
  };
  return {
    ...without(api, 'auth', 'definition'),
    baseUrl: serverUrl,
    servers: [],
    folders: api.folders.map(folder),
    requests: api.requests.map(request),
  };
}

function project(apis: readonly RestApi[]): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-convert-fixtures',
    name: 'Convert fixtures',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    environments: [],
    keystores: [],
    sequences: [],
    mocks: [],
    containers: { rest: apis.map((api, order) => ({ ...sendable(api), order })) },
  } as unknown as Project;
}

/** A value a script set from the clock, which differs between two sends. */
const clockFree = (values: readonly ScriptValue[]): ScriptValue[] =>
  values.map((v) => (/^\d{13}$/.test(v.value) ? { ...v, value: '<now>' } : v));

/** Sends every REST request of the collections and returns what each recorded. */
async function send(collections: readonly MappedCollectionV3Entry[], rewrite: Rewrite) {
  const apis = collections.flatMap((c) => (c.rest !== undefined ? [rewriteRest(c.rest, rewrite)] : []));
  const p = project(apis);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    scripting: new RequestScripting({ sandbox, checker, registry }),
    registry,
  };
  const scripts = new Map<string, { tests: { name: string; passed: boolean }[]; values: ScriptValue[] }>();
  const { selected } = selectRequests(p, [], registry);
  const result = await runRequests(selected, context, {
    onSent: (item, sent) => {
      scripts.set(item.path, {
        tests: (sent.script?.tests ?? []).map(({ name, passed }) => ({ name, passed })),
        values: clockFree(sent.script?.values ?? []),
      });
    },
  });
  return result.requests.map((r) => ({
    path: r.path,
    outcome: r.outcome,
    status: r.status,
    error: r.error?.code,
    assertions: r.assertions.map((a) => ({ label: a.label, outcome: a.outcome })),
    scripts: scripts.get(r.path),
  }));
}

/**
 * A gRPC level runs against the shared gRPC snapshot rather than a server: the crafted gRPC
 * request's service exists only in its fixture's `.proto`, and the level is the API's, which runs
 * for every request alike.
 */
async function runGrpcLevel(scripts: RequestScripts, phase: ScriptPhase): Promise<ScriptOutcome | undefined> {
  const source = scripts[phase];
  if (source === undefined) return undefined;
  return runScript({
    sandbox,
    phase,
    api: scripts.api,
    source: source.text,
    filename: `api.${phase}.${isLayeredApi(scripts.api) ? 'js' : 'ts'}`,
    request: GRPC,
    vars: {},
    props: {},
    secrets: {},
    requestName: 'SayHello',
  });
}

const observed = (outcome: ScriptOutcome | undefined) =>
  outcome === undefined
    ? undefined
    : {
        ok: outcome.ok,
        error: outcome.ok ? undefined : outcome.error.code,
        tests: outcome.tests.map(({ name, passed }) => ({ name, passed })),
        values: clockFree(outcome.values),
      };

// --- the tests ----------------------------------------------------------------------------------------

describe('the crafted fixtures convert', () => {
  it('no fixture call becomes a TODO', async () => {
    const todos: { fixture: string; where: string; todo: ConvertTodo }[] = [];
    for (const [name, load] of Object.entries(FIXTURES)) {
      const { collections } = await load();
      const left: { where: string; todo: ConvertTodo }[] = [];
      const convert = converted(left);
      for (const level of levelsOf(collections)) convert(level.scripts, level.protocol, level.where);
      todos.push(...left.map((t) => ({ fixture: name, ...t })));
    }
    expect(todos).toEqual([]);
  });

  describe.each(Object.entries(FIXTURES))('%s', (_name, load) => {
    it('type-checks every converted level with no problems', { timeout: 60_000 }, async () => {
      const { collections } = await load();
      const levels = levelsOf(collections);
      expect(levels.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const level of levels) {
        const typed = converted([])(level.scripts, level.protocol, level.where);
        for (const phase of ['pre', 'post'] as const) {
          const source = typed[phase];
          if (source === undefined) continue;
          const declarations = scriptDeclarations(
            level.protocol,
            phase,
            typed.secrets,
            levelScriptTypes(level.protocol, registry),
            registry,
          );
          for (const d of await checker.check({ source: source.text, declarations, api: 'wirebench' })) {
            problems.push(`${level.where} ${phase}:${String(d.line)}: ${d.message}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });

    it('records the same tests and values layered and converted', { timeout: 60_000 }, async () => {
      const { collections } = await load();
      const layered = await send(collections, switchedOn);
      const typed = await send(collections, converted([]));
      expect(layered.length).toBeGreaterThan(0);
      // Neither send may fail before its scripts ran, nor on a type error.
      for (const r of [...layered, ...typed]) {
        expect(r.scripts, r.path).toBeDefined();
        expect(r.error, r.path).not.toBe('script-type-error');
      }
      // Something ran: a fixture whose scripts silently did nothing on both sides would agree vacuously.
      expect(
        layered.some((r) => (r.scripts?.tests.length ?? 0) + (r.scripts?.values.length ?? 0) + r.assertions.length > 0),
      ).toBe(true);
      expect(typed).toEqual(layered);

      const grpcLevels = levelsOf(collections).filter((level) => level.protocol === 'grpc');
      for (const level of grpcLevels) {
        const typedLevel = converted([])(level.scripts, level.protocol, level.where);
        for (const phase of ['pre', 'post'] as const) {
          const before = observed(await runGrpcLevel(level.scripts, phase));
          const after = observed(await runGrpcLevel(typedLevel, phase));
          expect(after, `${level.where} ${phase}`).toEqual(before);
        }
      }
    });
  });
});

// --- Bruno order --------------------------------------------------------------------------------------

/** A post-response script that records one test named after its level. */
const postResponse = (name: string): string =>
  `\nscript:post-response {\n  test("${name}", function() {\n    expect(res.getStatus()).to.equal(201);\n  });\n}\n`;

describe('Bruno order (spec §8)', () => {
  it('bruno inner-first order survives conversion', { timeout: 60_000 }, async () => {
    // The crafted collection, with a test on the API and the Users folder so the order shows.
    const files = new Map<string, string>();
    const root = fixture('bruno/crafted/basic');
    for (const [path, text] of await readBrunoFolder(root)) files.set(path, text);
    files.set('collection.bru', files.get('collection.bru')! + postResponse('api'));
    files.set('users/folder.bru', files.get('users/folder.bru')! + postResponse('folder'));
    const { collection, report } = ocOfBrunoFolder(files, 'basic');
    const { collections } = mapBruno(collection, report);
    expect(collections[0]?.rest?.scripts?.postResponseOrder).toBe('inner-first');
    // Converting the API level keeps its order.
    expect(rewriteRest(collections[0]!.rest!, converted([])).scripts).toMatchObject({
      api: 'wirebench',
      postResponseOrder: 'inner-first',
    });

    const createUser = (sent: Awaited<ReturnType<typeof send>>) =>
      sent.find((r) => r.path.endsWith('Create user'))?.scripts?.tests.map((t) => t.name);
    const layered = createUser(await send(collections, switchedOn));
    const typed = createUser(await send(collections, converted([])));
    expect(layered).toEqual(['returns the created user', 'folder', 'api']);
    expect(typed).toEqual(layered);
  });
});
