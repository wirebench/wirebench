/**
 * Scripts imported from another client run (script layers): an Insomnia export is imported, its
 * scripts arrive switched off, and once switched on a variable the first request's script sets is
 * what the second request sends.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapInsomnia } from '../../../src/import/insomnia/map.js';
import { parseInsomnia } from '../../../src/import/insomnia/parse.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { apiRequests } from '../../../src/rest/model.js';
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
  return {
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
  } as unknown as Project;
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
