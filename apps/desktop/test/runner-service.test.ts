// @vitest-environment node
/**
 * The Runner end to end through the app's own send path (#336): a folder, an API, a project or a
 * sequence run once per data row, each request reported as it ends, History entries tagged with the
 * run, the run kept in the history under user data, and the data file's path never sent out of main.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createApi,
  createFolder,
  createProject,
  createRestRequest,
  createSequence,
  createSequenceStep,
} from '@wirebench/engine';
import type { Assertion, Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { RunnerService, withUnchecked } from '../src/main/runner/runner-service.js';
import { RunnerHistoryStore, RunnerSettingsStore } from '../src/main/runner/stores.js';
import { defaultRunnerSettings } from '../src/shared/runner-defaults.js';
import type { RunnerProgressEvent, RunnerRequestResult } from '../src/shared/runner-wire.js';

let url = '';
let userDataDir = '';
let seen: string[] = [];
let release: (() => void) | undefined;
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  seen.push(req.url ?? '/');
  if (path === '/hang') {
    release = () => res.writeHead(200).end('{}');
    return;
  }
  res.writeHead(path === '/broken' ? 500 : 200, { 'content-type': 'application/json' });
  res.end('{}');
});

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-runner-service-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await rm(userDataDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const ok: { assertions: Assertion[] } = { assertions: [{ type: 'status', equals: 200 }] };

function project(): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    containers: {
      rest: [
        createApi('Shop', {
          id: 'A1',
          baseUrl: url,
          requests: [{ ...createRestRequest('top', { id: 'top', order: 0, url: '/top?u=${#Data#user}' }), ...ok }],
          folders: [
            createFolder('Users', {
              id: 'F1',
              order: 1,
              requests: [
                { ...createRestRequest('one', { id: 'one', order: 0, url: '/one?u=${#Data#user}' }), ...ok },
                { ...createRestRequest('two', { id: 'two', order: 1, url: '${#Data#path}' }), ...ok },
              ],
            }),
          ],
        }),
        createApi('Slow', {
          id: 'A2',
          baseUrl: url,
          order: 5,
          requests: [createRestRequest('hang', { id: 'hang', url: '/hang' })],
        }),
      ],
    },
    sequences: [createSequence('Flow', { id: 'S1', steps: [createSequenceStep('one', { id: 'T1' })] })],
  };
}

/** The request surface a send reads: the project the requests live in, and their names. */
function surface(projectId: string, model: Project, environmentId?: string) {
  return {
    runContextFor: () => ({
      project: model,
      projectDir: '/tmp/none',
      ...(environmentId !== undefined ? { environmentId } : {}),
    }),
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    projectId: () => projectId,
    requestMeta: () => undefined,
    restMeta: (id: string) => ({ requestName: id, apiName: 'Shop', folderPath: '' }),
  } as unknown as RequestChannelDeps['project'];
}

/** A protected environment the run is under, and the person's answer when asked about it (#345). */
interface Guard {
  readonly confirm: (environmentNames: readonly string[]) => Promise<boolean>;
}

const PROD = {
  id: 'prod',
  name: 'Prod',
  slug: 'prod',
  order: 0,
  endpoints: {},
  properties: {},
  disabledProperties: [],
  protected: true,
};

async function harness(projectId: string, files: Record<string, string> = {}, guard?: Guard) {
  seen = [];
  const history = new HistoryService(userDataDir);
  await history.open(projectId);
  const model = guard === undefined ? project() : { ...project(), environments: [PROD] };
  const events: RunnerProgressEvent[] = [];
  const store = join(userDataDir, projectId);
  const settings = new RunnerSettingsStore(store);
  const runs = new RunnerHistoryStore(store);
  const runner = new RunnerService({
    service: new EngineService(),
    requests: {
      project: surface(projectId, model, guard !== undefined ? PROD.id : undefined),
      history,
      ...(guard !== undefined ? { confirmProtected: guard.confirm } : {}),
    },
    modelOf: () => model,
    settings,
    history: runs,
    emit: (event) => events.push(event),
    readText: (path) =>
      Object.hasOwn(files, path) ? Promise.resolve(files[path]!) : Promise.reject(new Error(`ENOENT ${path}`)),
  });
  const historyLines = async (): Promise<string[]> =>
    (await readFile(historyFilePath(userDataDir, projectId), 'utf8')).trim().split('\n');
  return { runner, events, settings, runs, historyLines };
}

const ROWS = 'user,path\nann,/two\nbob,/broken\n';

describe('withUnchecked (#637)', () => {
  const summary = { total: 3, passed: 2, failed: 0, errored: 1, skipped: 0, durationMs: 5 };
  const row = (outcome: RunnerRequestResult['outcome'], checks: number): RunnerRequestResult => ({
    path: 'Shop/x',
    name: 'x',
    protocol: 'rest',
    outcome,
    assertions: Array.from({ length: checks }, () => ({ type: 'status', label: 'status is 200', outcome: 'passed' })),
  });

  it('counts the passes with no checks, never a failure or an error', () => {
    expect(withUnchecked(summary, [row('passed', 0), row('passed', 1), row('errored', 0)])).toEqual({
      ...summary,
      unchecked: 1,
    });
  });

  it('leaves the summary as it was when every pass was checked', () => {
    expect(withUnchecked(summary, [row('passed', 1), row('passed', 2), row('errored', 0)])).toBe(summary);
  });
});

describe('RunnerService', () => {
  it('describes a folder, an API, the project and a sequence', async () => {
    const { runner } = await harness('P-state');
    expect(await runner.state('F1')).toMatchObject({
      kind: 'folder',
      name: 'Users',
      requests: [{ id: 'one' }, { id: 'two' }],
    });
    expect((await runner.state('A1')).requests.map((r) => r.id)).toEqual(['top', 'one', 'two']);
    expect((await runner.state('P1')).kind).toBe('project');
    expect(await runner.state('S1')).toMatchObject({ kind: 'sequence', requests: [{ id: 'T1' }] });
    await expect(runner.state('nothing')).rejects.toMatchObject({ code: 'runner-nothing-to-run' });
  });

  it('lists the requests in the saved order, a new one at the end', async () => {
    const { runner, settings } = await harness('P-order');
    await settings.setSettings('A1', { ...defaultRunnerSettings(), order: ['two', 'gone', 'top'] });
    expect((await runner.state('A1')).requests.map((r) => r.id)).toEqual(['two', 'top', 'one']);
  });

  it('runs a folder once per row, reporting every request with its iteration', async () => {
    const { runner, events, runs, historyLines } = await harness('P-run', { '/data/rows.csv': ROWS });
    expect(await runner.chooseData('F1', () => Promise.resolve('/data/rows.csv'))).toEqual({
      cancelled: false,
      data: { name: 'rows.csv', columns: ['user', 'path'], rows: 2 },
    });
    const result = await runner.run({ targetId: 'F1', runId: 'R1' });

    expect(seen).toEqual(['/one?u=ann', '/two', '/one?u=bob', '/broken']);
    expect(result.summary).toMatchObject({ total: 4, passed: 3, failed: 1, iterations: { planned: 2, run: 2 } });
    expect(result.dataFile).toBe('rows.csv');
    // Every request here has a check, so no pass is counted as unchecked (#637).
    expect(result.summary.unchecked).toBeUndefined();
    expect(events.map((e) => [e.request.name, e.request.iteration?.index])).toEqual([
      ['one', 0],
      ['two', 0],
      ['one', 1],
      ['two', 1],
    ]);
    expect(JSON.stringify(result)).not.toContain('/data/');
    // Every send is in History, tagged with the run; the run itself is kept outside the project.
    const lines = await historyLines();
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ tags: ['runner:F1', 'run:R1'] });
    expect((await runs.list('F1')).map((entry) => entry.runId)).toEqual(['R1']);
    expect((await runner.historyGet('F1', 'R1')).run?.requests).toHaveLength(4);
  });

  it('asks once before a run under a protected environment, and sends nothing when declined', async () => {
    const confirm = vi.fn<(names: readonly string[]) => Promise<boolean>>(() => Promise.resolve(false));
    const { runner } = await harness('P-guard', { '/d.csv': ROWS }, { confirm });
    await runner.chooseData('F1', () => Promise.resolve('/d.csv'));

    await expect(runner.run({ targetId: 'F1', runId: 'R-declined' })).rejects.toMatchObject({
      code: 'send-declined',
    });
    expect(seen).toEqual([]);

    confirm.mockResolvedValue(true);
    const result = await runner.run({ targetId: 'F1', runId: 'R-confirmed' });
    expect(result.summary.total).toBe(4);
    // Once for the declined run, once for this one: never per request or per iteration.
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith(['Prod']);
  });

  it('runs no iteration after a failure when stop on first failure is on', async () => {
    const { runner, settings } = await harness('P-bail', { '/d.csv': 'user,path\nann,/broken\nbob,/two\n' });
    await settings.setSettings('F1', { ...defaultRunnerSettings(), bail: true });
    await settings.setDataPath('F1', '/d.csv');
    const result = await runner.run({ targetId: 'F1', runId: 'R2' });
    expect(seen).toEqual(['/one?u=ann', '/broken']);
    expect(result.summary.iterations).toEqual({ planned: 2, run: 1 });
  });

  it('runs only what is not excluded, in the saved order, the set number of times', async () => {
    const { runner, settings } = await harness('P-excluded', { '/d.csv': 'user\nann\n' });
    await settings.setDataPath('A1', '/d.csv');
    await settings.setSettings('A1', {
      ...defaultRunnerSettings(),
      iterations: 2,
      overrun: 'repeat-last',
      order: ['one', 'top'],
      excluded: ['two'],
    });
    await runner.run({ targetId: 'A1', runId: 'R3' });
    expect(seen).toEqual(['/one?u=ann', '/top?u=ann', '/one?u=ann', '/top?u=ann']);
  });

  it('refuses a run with every request excluded', async () => {
    const { runner, settings } = await harness('P-none');
    await settings.setSettings('F1', { ...defaultRunnerSettings(), excluded: ['one', 'two'] });
    await expect(runner.run({ targetId: 'F1', runId: 'R8' })).rejects.toMatchObject({
      code: 'runner-nothing-to-run',
    });
  });

  it('lays the row over a sequence’s steps', async () => {
    const { runner, settings } = await harness('P-seq', { '/d.csv': 'user\nann\nbob\n' });
    await settings.setDataPath('S1', '/d.csv');
    const result = await runner.run({ targetId: 'S1', runId: 'R4' });
    expect(seen).toEqual(['/one?u=ann', '/one?u=bob']);
    expect(result.requests.map((r) => [r.path, r.iteration?.index])).toEqual([
      ['Flow/1. one', 0],
      ['Flow/1. one', 1],
    ]);
  });

  it('refuses a run whose data file does not read, before anything is sent', async () => {
    const { runner, settings } = await harness('P-unreadable');
    await settings.setDataPath('F1', '/missing.csv');
    await expect(runner.run({ targetId: 'F1', runId: 'R5' })).rejects.toMatchObject({
      code: 'data-file-unreadable',
    });
    expect(seen).toEqual([]);
    expect((await runner.state('F1')).data).toMatchObject({
      name: 'missing.csv',
      error: { code: 'data-file-unreadable' },
    });
  });

  it('refuses a second run of the same target, and stops a run in flight', async () => {
    const { runner } = await harness('P-cancel');
    const running = runner.run({ targetId: 'A2', runId: 'R6' });
    await expect(runner.run({ targetId: 'A2', runId: 'R7' })).rejects.toMatchObject({
      code: 'runner-already-running',
    });
    await expect.poll(() => seen).toEqual(['/hang']);
    expect(runner.cancel('R6')).toEqual({ cancelled: true });
    const result = await running;
    release?.();
    expect(result.cancelled).toBe(true);
    expect(result.requests[0]?.outcome).toBe('errored');
    expect(runner.cancel('R6')).toEqual({ cancelled: false });
  });

  it('forgets a data file when asked, and reports a cancelled pick', async () => {
    const { runner } = await harness('P-clear', { '/d.csv': 'user\nann\n' });
    expect(await runner.chooseData('F1', () => Promise.resolve(undefined))).toEqual({ cancelled: true });
    await runner.chooseData('F1', () => Promise.resolve('/d.csv'));
    await runner.clearData('F1');
    expect((await runner.state('F1')).data).toBeUndefined();
  });
});
