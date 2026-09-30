/**
 * A fifth protocol registered beside the built-in ones goes through select, run and secret needs
 * without any core file knowing it (protocol modules spec §10), and its containers live in a project
 * folder the way the built-in ones do.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadProject } from '../../src/project/load.js';
import { createProject, unsupportedOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { saveProject } from '../../src/project/save.js';
import { createProtocolRegistry } from '../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import { createApi, createRestRequest } from '../../src/rest/model.js';
import type { RunContext } from '../../src/run/context.js';
import { runRequests } from '../../src/run/run.js';
import { secretNeedsOf } from '../../src/run/secret-needs.js';
import { findStepRequest, selectRequests } from '../../src/run/select.js';
import { createScriptChecker } from '../../src/script/check/host.js';
import { RequestScripting } from '../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../src/script/sandbox/host.js';
import { echoApi, echoProtocol, echoRequest, withEchoApis } from '../helpers/echo-protocol.js';
import type { EchoApi } from '../helpers/echo-protocol.js';
import { startTestRestServer } from '../helpers/test-rest-server.js';
import type { TestRestServer } from '../helpers/test-rest-server.js';

const registry = createProtocolRegistry([...BUILTIN_PROTOCOLS, echoProtocol], { features: [SCRIPTS_FEATURE] });

let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-echo-'));
});

afterAll(async () => {
  await rest.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(): Project {
  const base: Project = {
    ...createProject('Echo', { id: 'proj-echo' }),
    properties: { greeting: 'hello' },
    apis: [
      createApi('Api', {
        id: 'api-1',
        slug: 'api',
        order: 1,
        requests: [
          {
            ...createRestRequest('Ping', { id: 'req-ping', url: `${rest.url}/echo` }),
            assertions: [{ type: 'status', equals: 200 }],
          },
        ],
      }),
    ],
  };
  return withEchoApis(base, [
    echoApi('Mirror', 0, [
      echoRequest('Greeting', '{"greeting":"${#Project#greeting}"}', {
        assertions: [{ type: 'match', language: 'jsonpath', expression: '$.greeting', equals: 'hello' }],
      }),
      echoRequest('Token', 'token=${secret:echo_token}', { assertions: [{ type: 'status', equals: 200 }] }),
    ]),
  ]);
}

function contextFor(p: Project, secrets: Readonly<Record<string, string>> = {}): RunContext {
  return { project: p, projectDir: dir, overrides: {}, getSecret: (ref) => Promise.resolve(secrets[ref]), registry };
}

describe('the echo protocol beside the built-in ones', () => {
  it('is selected in explorer order with the REST requests, by display path and by disk path', () => {
    const p = project();
    expect(selectRequests(p, [], registry).selected.map((item) => [item.kind, item.path])).toEqual([
      ['echo', 'Mirror/Greeting'],
      ['echo', 'Mirror/Token'],
      ['rest', 'Api/Ping'],
    ]);
    expect(selectRequests(p, ['Mirror/Token'], registry).selected.map((item) => item.path)).toEqual(['Mirror/Token']);
    expect(
      selectRequests(p, ['apis/mirror/requests/greeting.request.yaml'], registry).selected.map((item) => item.path),
    ).toEqual(['Mirror/Greeting']);
  });

  it('is not there for a registry that does not hold it', () => {
    const p = project();
    expect(selectRequests(p, []).selected.map((item) => item.path)).toEqual(['Api/Ping']);
    expect(selectRequests(p, ['Mirror']).unmatched).toEqual(['Mirror']);
    expect(findStepRequest(p, 'echo-req-greeting')).toEqual({ kind: 'missing' });
  });

  it('runs beside a REST request, with a match assertion on what it echoed', async () => {
    const p = project();
    const { selected } = selectRequests(p, ['Mirror/Greeting', 'Api/Ping'], registry);
    const result = await runRequests(selected, contextFor(p));
    expect(result.requests.map((r) => [r.path, r.protocol, r.outcome, r.status])).toEqual([
      ['Mirror/Greeting', 'echo', 'passed', 200],
      ['Api/Ping', 'rest', 'passed', 200],
    ]);
    expect(result.requests[0]?.assertions).toMatchObject([{ type: 'match', outcome: 'passed' }]);
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
  });

  it('expands a secret token through the run’s secrets, and refuses the send without it', async () => {
    const p = project();
    const { selected } = selectRequests(p, ['Mirror/Token'], registry);
    const given = await runRequests(selected, contextFor(p, { 'secret:echo_token': 'abc123def456ghi789' }));
    expect(given.requests[0]).toMatchObject({ protocol: 'echo', outcome: 'passed' });
    const missing = await runRequests(selected, contextFor(p));
    expect(missing.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'secret-missing' } });
  });

  it('errors a request whose protocol the run’s registry does not hold', async () => {
    const p = project();
    const { selected } = selectRequests(p, ['Mirror/Greeting'], registry);
    const result = await runRequests(selected, {
      project: p,
      projectDir: dir,
      overrides: {},
      getSecret: () => Promise.resolve(undefined),
    });
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'project-kind-not-supported' } });
  });

  it('has the secret token in its text found by secretNeedsOf', () => {
    const p = project();
    const { selected } = selectRequests(p, [], registry);
    expect(secretNeedsOf(selected, p, {}, undefined, registry)).toEqual([
      { ref: 'secret:echo_token', envName: 'ECHO_TOKEN', purpose: 'secret "echo_token"', usedBy: ['Mirror/Token'] },
    ]);
  });

  it('is found as a sequence step by its request id', () => {
    const found = findStepRequest(project(), 'echo-req-greeting', registry);
    expect(found.kind === 'found' ? [found.selected.kind, found.selected.path] : found.kind).toEqual([
      'echo',
      'Mirror/Greeting',
    ]);
  });
});

describe('an echo API in a project folder', () => {
  const secretNames = { echo_token: 'abc123def456ghi789', echo_extra: 'zyx987wvu654tsr321' };
  const mirror: EchoApi = {
    kind: 'echo',
    id: 'echo-api-1',
    name: 'Mirror',
    slug: 'Mirror',
    order: 0,
    requests: [
      { id: 'echo-req-1', name: 'First', slug: 'First', text: 'hello' },
      {
        id: 'echo-req-2',
        name: 'Second',
        slug: 'Second',
        text: 'token=${secret:echo_token}',
        scripts: {
          api: 'wirebench',
          enabled: true,
          secrets: ['echo_extra'],
          pre: { text: "request.text = request.text + ' scripted';\n" },
          post: { text: "test('echoed', () => expect(response.text).toContain(' scripted'));\n" },
        },
      },
    ],
  };
  const onDisk: Project = {
    ...createProject('Echo on disk', { id: 'echo-project' }),
    extraContainers: { echo: [mirror] },
  };
  const sandbox = createScriptSandbox();
  const checker = createScriptChecker();
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'wirebench-echo-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  afterAll(async () => {
    await sandbox.dispose();
    await checker.dispose();
  });

  const filesOf = async (): Promise<Buffer[]> =>
    Promise.all(
      [
        'wirebench.yaml',
        'apis/Mirror/api.yaml',
        'apis/Mirror/requests/First.request.yaml',
        'apis/Mirror/requests/Second.request.yaml',
      ].map((file) => readFile(join(folder, file))),
    );

  it(
    'is written as its module says, then loaded, selected, run with its script and secrets, and saved byte for byte',
    { timeout: 30_000 },
    async () => {
      const first = await saveProject(onDisk, folder, { registry });
      expect(first.written).toEqual([
        'apis/Mirror/api.yaml',
        'apis/Mirror/requests/First.request.yaml',
        'apis/Mirror/requests/Second.request.yaml',
        'wirebench.yaml',
      ]);
      expect(await readFile(join(folder, 'apis', 'Mirror', 'api.yaml'), 'utf8')).toBe(
        'id: echo-api-1\nkind: echo\nname: Mirror\norder: 0\n',
      );
      expect(await readFile(join(folder, 'apis', 'Mirror', 'requests', 'First.request.yaml'), 'utf8')).toBe(
        'id: echo-req-1\nkind: echo\nname: First\ntext: hello\n',
      );
      const before = await filesOf();

      const loaded = await loadProject(folder, { registry });
      expect(loaded.problems).toEqual([]);
      expect(loaded.project.extraContainers).toEqual({ echo: [mirror] });

      const { selected, unmatched } = selectRequests(loaded.project, [], registry);
      expect(unmatched).toEqual([]);
      expect(selected.map((item) => item.path)).toEqual(['Mirror/First', 'Mirror/Second']);
      expect(secretNeedsOf(selected, loaded.project, {}, undefined, registry).map((need) => need.ref)).toEqual([
        'secret:echo_token',
        'secret:echo_extra',
      ]);

      const run = await runRequests(selected, {
        project: loaded.project,
        projectDir: folder,
        overrides: {},
        getSecret: (ref) => Promise.resolve((secretNames as Record<string, string>)[ref.replace(/^secret:/, '')]),
        scripting: new RequestScripting({ sandbox, checker, registry }),
        registry,
      });
      expect(run.summary).toMatchObject({ total: 2, passed: 2, errored: 0, failed: 0 });
      expect(run.requests[1]).toMatchObject({
        outcome: 'passed',
        assertions: [{ type: 'script', label: 'echoed', outcome: 'passed' }],
      });

      const second = await saveProject(loaded.project, folder, { registry });
      expect(second.written).toEqual([]);
      expect(second.removed).toEqual([]);
      expect(await filesOf()).toEqual(before);
    },
  );

  it('removes the file of a request that is gone, and nothing else', async () => {
    await saveProject(onDisk, folder, { registry });
    const shorterMirror: EchoApi = { ...mirror, requests: mirror.requests.slice(0, 1) };
    const shorter: Project = { ...onDisk, extraContainers: { echo: [shorterMirror] } };

    const result = await saveProject(shorter, folder, { registry });

    expect(result.removed).toEqual(['apis/Mirror/requests/Second.request.yaml']);
    expect(result.written).toEqual([]);
  });

  it('is a placeholder to a registry with no echo module, and is left as it is', async () => {
    await saveProject(onDisk, folder, { registry });
    const apiFile = join(folder, 'apis', 'Mirror', 'api.yaml');
    const before = await readFile(apiFile);

    const loaded = await loadProject(folder);
    expect(loaded.project.extraContainers).toBeUndefined();
    expect(unsupportedOf(loaded.project)).toEqual([
      { dir: 'apis', slug: 'Mirror', kind: 'echo', reason: 'unknown-kind', name: 'Mirror', order: 0 },
    ]);
    expect(loaded.problems.map((problem) => problem.code)).toEqual(['container-unsupported']);

    const saved = await saveProject(loaded.project, folder);
    expect(saved.written).toEqual([]);
    expect(saved.removed).toEqual([]);
    expect((await readFile(apiFile)).equals(before)).toBe(true);
  });
});
