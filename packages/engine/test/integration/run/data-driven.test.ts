/**
 * A data-driven run end to end (#336): each iteration's row reaches the requests as `${#Data#…}` and
 * the scripts as `iteration.data`, and one sender and one pacer serve every iteration.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { parseDataFile } from '../../../src/run/data-file.js';
import { createPacer, iterationContext, runIterations } from '../../../src/run/iterate.js';
import { planIterations } from '../../../src/run/iterations.js';
import { createRunSender, runRequests } from '../../../src/run/run.js';
import type { SentRequest } from '../../../src/run/run.js';
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
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-data-'));
});

afterAll(async () => {
  await rest.close();
  await sandbox.dispose();
  await checker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function project(requests: readonly RestRequestDef[]): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-data',
    name: 'Data',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    containers: {
      rest: [{ ...createApi('Api', { id: 'api-1', slug: 'api', order: 0, baseUrl: '' }), requests: [...requests] }],
    },
    environments: [],
    keystores: [],
    sequences: [],
    mocks: [],
  } as unknown as Project;
}

const lookup = (user: string): RestRequestDef => ({
  ...createRestRequest('Lookup', { id: 'rest-lookup', order: 0, url: `${rest.url}/echo?user=${user}` }),
  assertions: [{ type: 'status', equals: 200 }],
});

function contextFor(p: Project): RunContext {
  return {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    scripting: new RequestScripting({ sandbox, checker }),
  };
}

/** Runs `p` once per planned iteration through one sender, as the command line does. */
async function runData(p: Project, plan: ReturnType<typeof planIterations>, options: { bail?: boolean } = {}) {
  const context = contextFor(p);
  const { selected } = selectRequests(p, []);
  const send = createRunSender(context);
  const pace = createPacer(5);
  const urls: string[] = [];
  const onSent = (_item: unknown, sent: SentRequest): void => {
    if (sent.exchange?.kind === 'rest') urls.push(sent.exchange.rest.request.url);
  };
  const result = await runIterations(
    plan,
    (iteration) =>
      runRequests(selected, iterationContext(context, iteration), {
        send,
        pace,
        onSent,
        ...(options.bail !== undefined ? { bail: options.bail } : {}),
      }),
    options,
  );
  return { result, urls };
}

describe('a data-driven run', () => {
  it('sends each row through ${#Data#…}', async () => {
    const table = parseDataFile('user\nann\nbob\n', 'csv');
    const { result, urls } = await runData(project([lookup('${#Data#user}')]), planIterations({ rows: table.rows }));
    expect(urls.map((url) => new URL(url).searchParams.get('user'))).toEqual(['ann', 'bob']);
    expect(result.summary).toMatchObject({ total: 2, passed: 2, iterations: { planned: 2, run: 2 } });
    expect(result.requests.map((r) => r.iteration?.row)).toEqual([0, 1]);
  });

  it('never reads a row through the ${column} shorthand (D1, #569)', async () => {
    const table = parseDataFile('user\nann\nbob\n', 'csv');
    const { result, urls } = await runData(project([lookup('${user}')]), planIterations({ rows: table.rows }));
    expect(urls).toEqual([]);
    expect(result.requests.map((r) => [r.outcome, r.error?.code])).toEqual([
      ['errored', 'rest-unresolved-properties'],
      ['errored', 'rest-unresolved-properties'],
    ]);
  });

  it('lets a post-response script test the row', { timeout: 30_000 }, async () => {
    const request: RestRequestDef = {
      ...lookup('${#Data#user}'),
      scripts: {
        api: 'wirebench',
        enabled: true,
        secrets: [],
        post: {
          text: [
            'test("echoes the row", () => {',
            '  const body = response.json() as { query: Record<string, string> };',
            '  expect(body.query["user"]).toBe(iteration.data.get("expected") ?? "");',
            '});',
          ].join('\n'),
        },
      },
    };
    const table = parseDataFile('user,expected\nann,ann\nbob,nope\n', 'csv');
    const { result } = await runData(project([request]), planIterations({ rows: table.rows }));
    expect(result.requests.map((r) => r.outcome)).toEqual(['passed', 'failed']);
  });

  it('stops after the iteration that failed under bail', async () => {
    const failing: RestRequestDef = { ...lookup('${#Data#user}'), assertions: [{ type: 'status', equals: 201 }] };
    const table = parseDataFile('user\nann\nbob\ncy\n', 'csv');
    const { result, urls } = await runData(project([failing]), planIterations({ rows: table.rows }), { bail: true });
    expect(urls).toHaveLength(1);
    expect(result.summary.iterations).toEqual({ planned: 3, run: 1 });
  });
});
