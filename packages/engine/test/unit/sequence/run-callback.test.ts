// packages/engine/test/unit/sequence/run-callback.test.ts
/**
 * A sequence step with a callback assertion: the cursor is taken before the step is sent, the value an
 * earlier step lifted correlates the callback, and the run says what it waits for.
 */
import { describe, expect, it } from 'vitest';
import type { CallbackClock, CallbackWaiting } from '../../../src/assert/callback.js';
import type { CaptureDetailView, CaptureSource } from '../../../src/assert/capture-source.js';
import type { AssertionSubject, CallbackAssertion } from '../../../src/assert/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project, PropertyMap } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createSequence, createSequenceStep } from '../../../src/sequence/model.js';
import { runSequence } from '../../../src/sequence/run.js';
import type { CallbackStep, SequenceStepSender } from '../../../src/sequence/run.js';

const HOOK = '01K000000000000000000000H1';

const project = (): Project => ({
  ...createProject('P', { id: 'P' }),
  containers: {
    rest: [
      createApi('Shop', {
        id: 'A',
        requests: [createRestRequest('Order', { id: 'order' }), createRestRequest('Pay', { id: 'pay' })],
      }),
    ],
  },
});

const json = (body: unknown): AssertionSubject => ({
  protocol: 'rest',
  status: 200,
  durationMs: 5,
  bodyText: JSON.stringify(body),
  bodyKind: 'json',
  headers: [],
});

const CALLBACK: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 2_000,
  match: { method: 'POST', body: { language: 'jsonpath', path: '$.orderId', equals: '${#Sequence#orderId}' } },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
};

function capture(orderId: string): CaptureDetailView {
  return {
    id: '01K00000000000000000000002',
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    path: '/',
    signature: null,
    headers: [],
    bodyText: JSON.stringify({ orderId, status: 'paid' }),
    truncated: false,
  };
}

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

describe('runSequence with a callback assertion', () => {
  it('prepares before the send, correlates by a transferred value, and reports the wait', async () => {
    const events: string[] = [];
    let paid = false;
    const send: SequenceStepSender = (step) => {
      events.push(`send ${step.step.requestId}`);
      if (step.step.requestId === 'pay') paid = true;
      return Promise.resolve({ subject: json({ orderId: 'A-17' }) });
    };
    const source: CaptureSource = {
      resolve: () => {
        events.push('resolve');
        return Promise.resolve({ hookId: HOOK });
      },
      cursor: () => {
        events.push('cursor');
        return Promise.resolve(null);
      },
      after: () => Promise.resolve(paid ? [capture('A-17')] : []),
      detail: () => Promise.resolve(capture('A-17')),
    };
    const waited: [CallbackStep, readonly CallbackWaiting[]][] = [];
    const scopesAsked: PropertyMap[] = [];
    const result = await runSequence(
      createSequence('Checkout', {
        id: 'S',
        steps: [
          createSequenceStep('order', {
            id: 'T-order',
            transfers: [{ name: 'orderId', from: 'body', language: 'jsonpath', expression: '$.orderId' }],
          }),
          createSequenceStep('pay', { id: 'T-pay', assertions: [CALLBACK] }),
        ],
      }),
      project(),
      send,
      {
        captures: source,
        callbackClock: fakeClock(),
        onCallbackWaiting: (step, waiting) => waited.push([step, waiting]),
        callbackScopes: (_step, sequence) => {
          scopesAsked.push(sequence);
          return { project: {}, global: {}, system: {}, sequence };
        },
      },
    );

    expect(events).toEqual(['send order', 'resolve', 'cursor', 'send pay']);
    expect(scopesAsked).toEqual([{ orderId: 'A-17' }]);
    expect(waited).toEqual([
      [
        { index: 1, stepId: 'T-pay', name: 'Pay' },
        [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 2_000 }],
      ],
    ]);
    expect(result.outcome).toBe('passed');
    expect(result.steps[1]?.assertions[0]).toMatchObject({ type: 'callback', outcome: 'passed' });
  });

  it('uses the Sequence scope alone when the host gives no scopes, and fails a wrong correlation', async () => {
    const send: SequenceStepSender = () => Promise.resolve({ subject: json({ orderId: 'A-17' }) });
    const source: CaptureSource = {
      resolve: () => Promise.resolve({ hookId: HOOK }),
      cursor: () => Promise.resolve(null),
      after: (_hook, cursor) => Promise.resolve(cursor === null ? [capture('B-99')] : []),
      detail: () => Promise.resolve(capture('B-99')),
    };
    const result = await runSequence(
      createSequence('Checkout', {
        id: 'S',
        steps: [
          createSequenceStep('order', {
            id: 'T-order',
            transfers: [{ name: 'orderId', from: 'body', language: 'jsonpath', expression: '$.orderId' }],
          }),
          createSequenceStep('pay', { id: 'T-pay', assertions: [CALLBACK] }),
        ],
      }),
      project(),
      send,
      { captures: source, callbackClock: fakeClock() },
    );
    expect(result.steps[1]?.outcome).toBe('failed');
    expect(result.steps[1]?.assertions[0]?.message).toBe(
      'no capture matched within 2 s — 1 arrived; closest: POST / (body $.orderId differs)',
    );
  });

  it('errors a step the host could not send, after the prepare and without waiting', async () => {
    const calls: string[] = [];
    const send: SequenceStepSender = () => Promise.resolve({ error: { code: 'x', message: 'refused' } });
    const source: CaptureSource = {
      resolve: () => {
        calls.push('resolve');
        return Promise.resolve({ hookId: HOOK });
      },
      cursor: () => {
        calls.push('cursor');
        return Promise.resolve(null);
      },
      after: () => {
        calls.push('after');
        return Promise.resolve([]);
      },
      detail: () => Promise.resolve(capture('A-17')),
    };
    let now = 0;
    const sleeps: number[] = [];
    const clock: CallbackClock = {
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    };
    const waited: CallbackStep[] = [];
    const result = await runSequence(
      createSequence('Checkout', {
        id: 'S',
        steps: [createSequenceStep('pay', { id: 'T-pay', assertions: [CALLBACK] })],
      }),
      project(),
      send,
      { captures: source, callbackClock: clock, onCallbackWaiting: (step) => waited.push(step) },
    );

    expect(result.steps[0]).toMatchObject({ outcome: 'errored', error: { code: 'x', message: 'refused' } });
    expect(calls).toEqual(['resolve', 'cursor']);
    expect(waited).toEqual([]);
    expect(sleeps).toEqual([]);
  });
});
