/**
 * Run control in a run (#335), against a local server: a script's `execution.setNextRequest` and
 * `execution.skipRequest` steer an API run, within the requests the run selected and the jump limit,
 * and nowhere else — a name outside the selection, an endless loop, an abort and bail all hold.
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
import { RUN_CONTROL_LIMITS, runRequests, type RunOptions } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { startTestRestServer } from '../../helpers/index.js';
import type { TestRestServer } from '../../helpers/index.js';

let rest: TestRestServer;
let dir: string;
const sandbox = createScriptSandbox();

beforeAll(async () => {
  rest = await startTestRestServer({});
  dir = mkdtempSync(join(tmpdir(), 'wb-run-control-'));
});

afterAll(async () => {
  await rest.close();
  await sandbox.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Scripted {
  readonly pre?: string;
  readonly post?: string;
}

function request(name: string, order: number, scripts: Scripted = {}): RestRequestDef {
  const def = createRestRequest(name, { id: `req-${name}`, url: `${rest.url}/echo`, order });
  if (scripts.pre === undefined && scripts.post === undefined) return def;
  const own: RequestScripts = {
    api: 'wirebench',
    enabled: true,
    secrets: [],
    ...(scripts.pre !== undefined ? { pre: { text: scripts.pre } } : {}),
    ...(scripts.post !== undefined ? { post: { text: scripts.post } } : {}),
  };
  return { ...def, scripts: own };
}

function project(requests: readonly RestRequestDef[]): Project {
  const api = createApi('Shop', { id: 'api-shop', slug: 'Shop', order: 0, requests: [...requests] });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-run-control',
    name: 'Run control',
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

function contextFor(p: Project, signal?: AbortSignal): RunContext {
  return {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    scripting: new RequestScripting({ sandbox }),
    ...(signal !== undefined ? { signal } : {}),
  };
}

async function run(requests: readonly RestRequestDef[], options: RunOptions = {}, signal?: AbortSignal) {
  const p = project(requests);
  const { selected } = selectRequests(p, []);
  return runRequests(selected, contextFor(p, signal), { runControl: true, ...options });
}

/** Each result as `name:outcome`, in the order the run reported them. */
const path = (result: Awaited<ReturnType<typeof run>>): string[] =>
  result.requests.map((r) => `${r.name}:${r.outcome}`);

describe('run control in an API run', () => {
  it('jumps forward, reporting what it passed over as skipped', { timeout: 30_000 }, async () => {
    const result = await run([
      request('A', 0, { post: 'execution.setNextRequest("C");' }),
      request('B', 1),
      request('C', 2),
    ]);
    expect(path(result)).toEqual(['A:passed', 'B:skipped', 'C:passed']);
    expect(result.requests[0]?.control).toEqual({ next: 'C' });
    expect(result.summary).toMatchObject({ total: 3, passed: 2, skipped: 1 });
  });

  it('loops back with a counter until the script stops it', { timeout: 30_000 }, async () => {
    const result = await run([
      request('Poll', 0, {
        post: 'const n = Number(vars.get("n") ?? "0") + 1; vars.set("n", n); if (n < 3) execution.setNextRequest("Poll");',
      }),
      request('Done', 1),
    ]);
    expect(path(result)).toEqual(['Poll:passed', 'Poll:passed', 'Poll:passed', 'Done:passed']);
  });

  it('ends the run on null, the rest skipped and never sent', { timeout: 30_000 }, async () => {
    const result = await run([
      request('A', 0, { post: 'execution.setNextRequest(null);' }),
      request('B', 1),
      request('C', 2),
    ]);
    expect(path(result)).toEqual(['A:passed', 'B:skipped', 'C:skipped']);
    expect(result.requests[1]?.status).toBeUndefined();
    expect(result.requests[0]?.control).toEqual({ next: null });
  });

  it('skips a request from its pre-request script without sending it', { timeout: 30_000 }, async () => {
    const result = await run([
      request('A', 0, { pre: 'log("skipping"); execution.skipRequest();', post: 'throw new Error("never runs");' }),
      request('B', 1),
    ]);
    expect(path(result)).toEqual(['A:skipped', 'B:passed']);
    expect(result.requests[0]).toMatchObject({ control: { skipped: true }, scriptLog: ['skipping'] });
    expect(result.requests[0]?.status).toBeUndefined();
  });

  it('honours a jump set by the script that skipped', { timeout: 30_000 }, async () => {
    const result = await run([
      request('A', 0, { pre: 'execution.skipRequest(); execution.setNextRequest("C");' }),
      request('B', 1),
      request('C', 2),
    ]);
    expect(path(result)).toEqual(['A:skipped', 'B:skipped', 'C:passed']);
  });

  it('errors on a name the run did not select, and sends nothing more', { timeout: 30_000 }, async () => {
    const result = await run([request('A', 0, { post: 'execution.setNextRequest("Elsewhere");' }), request('B', 1)]);
    expect(path(result)).toEqual(['A:errored', 'B:skipped']);
    expect(result.requests[0]?.error).toMatchObject({ code: 'script-next-unknown' });
    expect(result.requests[1]?.status).toBeUndefined();
  });

  it('errors on a name outside the selection even when the project has it', { timeout: 30_000 }, async () => {
    const p = project([request('A', 0, { post: 'execution.setNextRequest("Hidden");' }), request('Hidden', 1)]);
    const { selected } = selectRequests(p, []);
    const result = await runRequests(selected.slice(0, 1), contextFor(p), { runControl: true });
    expect(path(result)).toEqual(['A:errored']);
    expect(result.requests[0]?.error).toMatchObject({ code: 'script-next-unknown' });
  });

  it('holds an endless loop at the jump limit', { timeout: 60_000 }, async () => {
    // A loop of skips sends nothing, so it is the cheapest endless loop a script can write.
    const result = await run([
      request('Spin', 0, { pre: 'execution.skipRequest(); execution.setNextRequest("Spin");' }),
    ]);
    expect(result.requests).toHaveLength(RUN_CONTROL_LIMITS.jumps + 1);
    expect(result.requests.at(-1)?.error).toMatchObject({ code: 'script-jump-limit' });
  });

  it('stops a loop on abort', { timeout: 30_000 }, async () => {
    const controller = new AbortController();
    let seen = 0;
    const result = await run(
      [request('Poll', 0, { post: 'execution.setNextRequest("Poll");' }), request('After', 1)],
      {
        onRequestDone: () => {
          seen += 1;
          if (seen === 2) controller.abort();
        },
      },
      controller.signal,
    );
    expect(path(result).slice(0, 2)).toEqual(['Poll:passed', 'Poll:passed']);
    expect(result.requests.slice(2).every((r) => r.outcome === 'skipped')).toBe(true);
    expect(result.requests.length).toBeLessThan(5);
  });

  it('is ignored by a run that does not obey run control, as a single send', { timeout: 30_000 }, async () => {
    const result = await run([request('Poll', 0, { post: 'execution.setNextRequest("Poll");' })], {
      runControl: false,
    });
    expect(path(result)).toEqual(['Poll:passed']);
    expect(result.requests[0]?.control).toBeUndefined();
    expect(result.requests[0]?.scriptLog).toEqual([
      'execution.setNextRequest is obeyed only in an API or folder run; ignored here',
    ]);
  });

  it('stops a loop under bail once a request fails', { timeout: 30_000 }, async () => {
    const result = await run(
      [request('Poll', 0, { post: 'test("fails", () => expect(1).toBe(2)); execution.setNextRequest("Poll");' })],
      { bail: true },
    );
    expect(path(result)).toEqual(['Poll:failed']);
  });
});
