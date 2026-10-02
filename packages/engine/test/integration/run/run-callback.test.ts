// packages/engine/test/integration/run/run-callback.test.ts
/**
 * `runRequests` with a callback assertion: the cursor is taken before the request reaches the server,
 * the wait starts after it answered, and a run without a capture source still sends and reports.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_CAPTURE_SOURCE_MESSAGE } from '../../../src/assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../../../src/assert/callback.js';
import type { CaptureDetailView, CaptureSource } from '../../../src/assert/capture-source.js';
import type { Assertion, CallbackAssertion } from '../../../src/assert/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';

const HOOK = '01K000000000000000000000H1';
const CAPTURE: CaptureDetailView = {
  id: '01K00000000000000000000002',
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  path: '/events',
  signature: null,
  headers: [['Content-Type', 'application/json']],
  bodyText: '{"status":"paid"}',
  truncated: false,
};
const CALLBACK: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 3_000,
  match: { method: 'POST', path: '/events' },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
};

let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-callback-'));
});

afterAll(async () => {
  await rest.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(assertions: readonly Assertion[]): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    apis: [
      createApi('Shop', {
        id: 'A1',
        slug: 'shop',
        baseUrl: rest.url,
        requests: [{ ...createRestRequest('Pay', { id: 'R1', method: 'POST', url: '/echo' }), assertions }],
      }),
    ],
  };
}

const contextFor = (p: Project): RunContext => ({
  project: p,
  projectDir: dir,
  overrides: {},
  getSecret: () => Promise.resolve(undefined),
});

function fakeClock(): CallbackClock {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('runRequests with a callback assertion', () => {
  it('takes the cursor before the send and waits after it', async () => {
    const before = rest.requests.length;
    const events: string[] = [];
    const source: CaptureSource = {
      resolve: (name) => {
        events.push(`resolve ${name} (server saw ${String(rest.requests.length - before)})`);
        return Promise.resolve({ hookId: HOOK });
      },
      cursor: () => {
        events.push(`cursor (server saw ${String(rest.requests.length - before)})`);
        return Promise.resolve(null);
      },
      after: () => {
        const sent = rest.requests.length - before;
        events.push(`after (server saw ${String(sent)})`);
        return Promise.resolve(sent > 0 ? [CAPTURE] : []);
      },
      detail: () => Promise.resolve(CAPTURE),
    };
    const waited: [string, readonly CallbackWaiting[]][] = [];
    const p = project([{ type: 'status', equals: 200 }, CALLBACK]);
    const result = await runRequests(selectRequests(p, []).selected, contextFor(p), {
      captures: source,
      callbackClock: fakeClock(),
      onCallbackWaiting: (path, waiting) => waited.push([path, waiting]),
    });

    expect(events).toEqual(['resolve orders-hook (server saw 0)', 'cursor (server saw 0)', 'after (server saw 1)']);
    expect(waited).toHaveLength(1);
    expect(waited[0]?.[1]).toEqual([{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 3_000 }]);
    const [request] = result.requests;
    expect(request?.outcome).toBe('passed');
    expect(request?.assertions.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'passed'],
      ['callback', 'passed'],
    ]);
    expect(request?.assertions[1]?.capture).toEqual({ hookId: HOOK, captureId: CAPTURE.id });
  });

  it('still sends without a source; only the callback errors', async () => {
    const before = rest.requests.length;
    const p = project([{ type: 'status', equals: 200 }, CALLBACK]);
    const result = await runRequests(selectRequests(p, []).selected, contextFor(p), { callbackClock: fakeClock() });
    expect(rest.requests.length - before).toBe(1);
    expect(result.summary).toMatchObject({ errored: 1, failed: 0 });
    expect(result.requests[0]?.assertions[1]).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'errored',
      message: NO_CAPTURE_SOURCE_MESSAGE,
    });
  });

  it('computes no callback scopes for a request without a callback assertion', async () => {
    const p = project([{ type: 'status', equals: 200 }]);
    const source: CaptureSource = {
      resolve: () => Promise.reject(new Error('unexpected')),
      cursor: () => Promise.reject(new Error('unexpected')),
      after: () => Promise.reject(new Error('unexpected')),
      detail: () => Promise.reject(new Error('unexpected')),
    };
    const result = await runRequests(selectRequests(p, []).selected, contextFor(p), { captures: source });
    expect(result.summary).toMatchObject({ passed: 1 });
  });
});
