/**
 * A fifth protocol runs scripts (spec §10): the test-only `echo` module has a scripting facet, and
 * the sandbox, the checker, the rules and the run go through it without a line of core naming it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { createProtocolRegistry } from '../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import type { RunContext } from '../../src/run/context.js';
import { runRequests } from '../../src/run/run.js';
import { selectRequests } from '../../src/run/select.js';
import { createScriptChecker } from '../../src/script/check/host.js';
import type { RequestScripts } from '../../src/script/model.js';
import { RequestScripting } from '../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../src/script/sandbox/host.js';
import { apiReference } from '../../src/script/types/api.js';
import { echoProtocol } from '../helpers/echo-protocol.js';
import type { EchoApi, EchoRequest } from '../helpers/echo-protocol.js';

const API_KEY = 'abc123def456ghi789';

const sandbox = createScriptSandbox();
const checker = createScriptChecker();
const dir = mkdtempSync(join(tmpdir(), 'wb-echo-scripts-'));
const registry = createProtocolRegistry([...BUILTIN_PROTOCOLS, echoProtocol], { features: [SCRIPTS_FEATURE] });

afterAll(async () => {
  await sandbox.dispose();
  await checker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const scripts = (extra: Partial<RequestScripts>): RequestScripts => ({
  api: 'wirebench',
  enabled: true,
  secrets: [],
  ...extra,
});

function project(requests: readonly EchoRequest[]): Project {
  const api: EchoApi = { kind: 'echo', id: 'echo-1', name: 'Echo', slug: 'echo', order: 0, requests };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-echo-scripts',
    name: 'Echo scripts',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
    sequences: [],
    extraContainers: { echo: [api] },
  } as unknown as Project;
}

async function run(requests: readonly EchoRequest[]) {
  const p = project(requests);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: {
      getSecret: (ref) => Promise.resolve(ref.replace(/^secret:/, '') === 'api_key' ? API_KEY : undefined),
    },
    scripting: new RequestScripting({ sandbox, checker, registry }),
    registry,
  };
  const { selected } = selectRequests(p, [], registry);
  return runRequests(selected, context);
}

describe('an echo request with scripts', () => {
  it(
    'sends the text its pre-request script rewrote, and records its post-response test',
    { timeout: 30_000 },
    async () => {
      const result = await run([
        {
          id: 'echo-ping',
          name: 'Ping',
          slug: 'ping',
          text: 'ping',
          scripts: scripts({
            pre: { text: "request.text = request.text + ' and back';\n" },
            post: { text: "test('echoed', () => expect(response.text).toBe('ping and back'));\n" },
          }),
        },
      ]);
      expect(result.requests[0]).toMatchObject({
        protocol: 'echo',
        outcome: 'passed',
        assertions: [{ type: 'script', label: 'echoed', outcome: 'passed' }],
      });
    },
  );

  it('shows the script a placeholder for a secret, and sends the value', { timeout: 30_000 }, async () => {
    const result = await run([
      {
        id: 'echo-key',
        name: 'Key',
        slug: 'key',
        text: 'key=${secret:api_key}',
        scripts: scripts({
          pre: { text: 'log(request.text);\n' },
          post: { text: `test('restored', () => expect(response.text).toBe('key=${API_KEY}'));\n` },
        }),
      },
    ]);
    const key = result.requests[0];
    expect(key).toMatchObject({ outcome: 'passed', assertions: [{ label: 'restored', outcome: 'passed' }] });
    expect(key?.scriptLog?.[0]).toMatch(/^key=wbsec[0-9a-f]+n0z$/);
  });

  it(
    'is held to the rules through its own inspect: a new secret reference is refused',
    { timeout: 30_000 },
    async () => {
      const result = await run([
        {
          id: 'echo-steal',
          name: 'Steal',
          slug: 'steal',
          text: 'ping',
          scripts: scripts({ pre: { text: "request.text = '${secret:other}';\n" } }),
        },
      ]);
      expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'script-secret-denied' } });
    },
  );

  it('is type-checked against its own declarations', { timeout: 30_000 }, async () => {
    const result = await run([
      {
        id: 'echo-typo',
        name: 'Typo',
        slug: 'typo',
        text: 'ping',
        scripts: scripts({ post: { text: 'log(response.txt);\n' } }),
      },
    ]);
    expect(result.requests[0]).toMatchObject({
      outcome: 'errored',
      error: { code: 'script-type-error', message: expect.stringContaining('typo.post.ts:1:') as unknown },
    });
  });
});

describe('the script API reference of a registry with a fifth protocol', () => {
  it('lists its sections, ordered by title', () => {
    expect(apiReference(registry).map((section) => section.title)).toEqual([
      'Every script',
      'Echo: pre-request',
      'Echo: post-response',
      'REST: shared by both phases',
      'REST: pre-request',
      'REST: post-response',
      'SOAP: pre-request',
      'SOAP: post-response',
      'gRPC: pre-request',
      'gRPC: post-response',
    ]);
  });
});
