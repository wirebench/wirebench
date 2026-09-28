// @vitest-environment node
/**
 * The desktop sequence runner end to end in main: a real engine service against a real server, the
 * steps sent through the ordinary REST send path, History entries tagged with the run, and the
 * security properties that only hold if the order of events is right:
 * - a transfer reads the unredacted response, not the redacted summary;
 * - a value marked secret is recorded for masking before its own step's History entry is written;
 * - nothing that crosses to the renderer carries it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  createSequence,
  createSequenceStep,
  entry,
  expandRestSendInput,
} from '@wirebench/engine';
import type { PropertyMap, Project, RestSendInput, SequenceStep } from '@wirebench/engine';
import type { WebContents } from 'electron';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { SequenceRunner } from '../src/main/sequence-runner.js';
import type { RestExchangeSummary, SequenceProgressEvent } from '../src/shared/wire-types.js';
import { restApiWire } from './helpers/wire-defaults.js';

/** Under a JSON key no redaction rule knows, so only the recorded value can mask it. */
const JWT = 'jwt-value-long-7e21c0';

let url = '';
let userDataDir = '';
let meCalls: (string | undefined)[] = [];
let release: (() => void) | undefined;
const server = createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jwt: JWT, user: 'ada' }));
  } else if (req.url === '/me') {
    meCalls.push(req.headers.authorization);
    res.writeHead(req.headers.authorization === `Bearer ${JWT}` ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'Ada', token: req.headers.authorization }));
  } else if (req.url === '/hang') {
    release = () => res.end('{}');
  } else {
    res.writeHead(404).end();
  }
});

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-sequence-runner-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await rm(userDataDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const TEMPLATES: Record<string, Pick<RestSendInput['request'], 'method' | 'url' | 'headers'>> = {
  login: { method: 'POST', url: '/login', headers: [] },
  me: { method: 'GET', url: '/me', headers: [entry('Authorization', 'Bearer ${#Sequence#jwt}')] },
  hang: { method: 'GET', url: '/hang', headers: [] },
};

function project(steps: SequenceStep[]): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    apis: [
      createApi('Shop', {
        id: 'A1',
        requests: Object.keys(TEMPLATES).map((id) => createRestRequest(id, { id })),
      }),
    ],
    sequences: [createSequence('Checkout', { id: 'S1', steps })],
  };
}

/** The request surface a send reads; `restSend` really expands, so the Sequence values are proved to arrive. */
function surface(projectId: string) {
  const restSend = vi.fn((requestId: string, _draft: unknown, _envId?: string, sequence?: PropertyMap) => {
    const template = TEMPLATES[requestId];
    if (template === undefined) return undefined;
    const { input, unresolved } = expandRestSendInput(
      {
        baseUrl: url,
        request: { ...template, pathParams: [], query: [], body: { kind: 'none' } },
        settings: { timeoutMs: 5_000, followRedirects: true },
      },
      { project: {}, global: {}, system: {}, ...(sequence !== undefined ? { sequence } : {}) },
    );
    return {
      input,
      unresolved,
      api: restApiWire(),
      request: { name: requestId },
      baseUrlSource: 'api',
      auth: { type: 'none' },
    };
  });
  return {
    restSend,
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    projectId: () => projectId,
    requestMeta: () => undefined,
    restMeta: (id: string) => ({ requestName: id, apiName: 'Shop', folderPath: '' }),
  } as unknown as RequestChannelDeps['project'];
}

async function harness(steps: SequenceStep[], projectId: string) {
  meCalls = [];
  const service = new EngineService();
  const history = new HistoryService(userDataDir);
  await history.open(projectId);
  const logged: { exchange: RestExchangeSummary }[] = [];
  const events: SequenceProgressEvent[] = [];
  const requests = {
    project: surface(projectId),
    history,
    onExchange: (row: { exchange: RestExchangeSummary }) => logged.push(row),
  } as unknown as RequestChannelDeps;
  const runner = new SequenceRunner();
  const model = project(steps);
  const deps = { service, requests, modelOf: () => model, emit: (event: SequenceProgressEvent) => events.push(event) };
  const historyLines = async (): Promise<string[]> =>
    (await readFile(historyFilePath(userDataDir, projectId), 'utf8')).trim().split('\n');
  return { runner, deps, service, logged, events, historyLines };
}

/** The raw response as the HTTP log shows it. */
function rawResponse(summary: RestExchangeSummary): string {
  return Buffer.from(summary.http.rawResponseBase64, 'base64').toString('utf8');
}

const LOGIN = createSequenceStep('login', {
  id: 'T1',
  transfers: [{ name: 'jwt', from: 'body', language: 'jsonpath', expression: '$.jwt', secret: true }],
});
const ME = createSequenceStep('me', {
  id: 'T2',
  transfers: [{ name: 'user', from: 'body', language: 'jsonpath', expression: '$.name' }],
  assertions: [{ type: 'status', equals: 200 }],
});
const sender = {} as WebContents;

describe('SequenceRunner', () => {
  it('carries a secret from one step to the next and never lets it out of main', async () => {
    const { runner, deps, logged, events, historyLines } = await harness([LOGIN, ME], 'P-secret');
    const result = await runner.run({ sequenceId: 'S1', runId: 'R1' }, deps, sender);

    expect(result.outcome).toBe('passed');
    expect(meCalls).toEqual([`Bearer ${JWT}`]);
    expect(result.steps[0]?.transfers).toEqual([{ name: 'jwt', outcome: 'set', secret: true }]);
    expect(result.steps[1]?.transfers).toEqual([{ name: 'user', outcome: 'set', secret: false, value: 'Ada' }]);
    expect(events.map((e) => e.step.index)).toEqual([0, 1]);

    // History, on disk: both steps tagged with the run, and the login step's own entry already masked,
    // because the value was recorded before that entry was written.
    const lines = await historyLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ tags: ['sequence:S1', 'run:R1'] });
      expect(line).not.toContain(JWT);
    }
    // The HTTP Log's rows: the raw response is masked, as for any recorded credential.
    expect(logged).toHaveLength(2);
    for (const row of logged) {
      expect(rawResponse(row.exchange)).not.toContain(JWT);
    }
    // What the run panel is sent carries no value of it at all.
    expect(JSON.stringify(events)).not.toContain(JWT);
    expect(JSON.stringify(result)).not.toContain(JWT);
  });

  it('refuses a second run of the same sequence while one is running, and cancels the step in flight', async () => {
    const hang = createSequenceStep('hang', { id: 'T3' });
    const { runner, deps, service } = await harness([hang, ME], 'P-cancel');
    const running = runner.run({ sequenceId: 'S1', runId: 'R2' }, deps, sender);
    await vi.waitFor(() => expect(release).toBeDefined());

    await expect(runner.run({ sequenceId: 'S1', runId: 'R3' }, deps, sender)).rejects.toMatchObject({
      code: 'sequence-already-running',
    });
    expect(runner.cancel('R2', service)).toEqual({ cancelled: true });
    const result = await running;
    release?.();
    release = undefined;

    expect(result.steps.map((s) => s.outcome)).toEqual(['errored', 'skipped']);
    expect(result.steps[1]?.skipped).toBe('cancelled');
    expect(runner.cancel('R2', service)).toEqual({ cancelled: false });
  });

  it('refuses a sequence the project does not have', async () => {
    const { runner, deps } = await harness([], 'P-none');
    await expect(runner.run({ sequenceId: 'nope', runId: 'R4' }, deps, sender)).rejects.toMatchObject({
      code: 'unknown-entity',
    });
  });
});
