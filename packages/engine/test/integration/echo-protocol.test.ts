/**
 * A fifth protocol registered beside the built-in ones goes through select, run and secret needs
 * without any core file knowing it (protocol modules spec §10). The run half: storage and scripts
 * join in later slices.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { createProtocolRegistry } from '../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import { createApi, createRestRequest } from '../../src/rest/model.js';
import type { RunContext } from '../../src/run/context.js';
import { runRequests } from '../../src/run/run.js';
import { secretNeedsOf } from '../../src/run/secret-needs.js';
import { findStepRequest, selectRequests } from '../../src/run/select.js';
import { echoApi, echoProtocol, echoRequest, withEchoApis } from '../helpers/echo-protocol.js';
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
