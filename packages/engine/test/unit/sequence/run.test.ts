/**
 * The sequence loop with a fake sender: what each step is sent with, what it lifts, how it ends, and
 * that a secret never leaves the engine unmasked.
 */
import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project, PropertyMap } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createSequence, createSequenceStep, SEQUENCE_LIMITS } from '../../../src/sequence/model.js';
import type { SequenceStep } from '../../../src/sequence/model.js';
import { runSequence } from '../../../src/sequence/run.js';
import type { ResolvedStep, SequenceStepSender } from '../../../src/sequence/run.js';
import { createWsApi, createWsRequest } from '../../../src/ws/model.js';

function project(): Project {
  return {
    ...createProject('P', { id: 'P' }),
    containers: {
      rest: [
        createApi('Shop', {
          id: 'A',
          requests: [
            createRestRequest('Log in', { id: 'login' }),
            { ...createRestRequest('Cart', { id: 'cart' }), assertions: [{ type: 'status', equals: 201 }] },
            createRestRequest('Pay', { id: 'pay' }),
          ],
        }),
      ],
      grpc: [
        createGrpcApi('Feed', {
          id: 'G',
          requests: [
            createGrpcRequest('Watch', { id: 'watch', methodKind: 'server-streaming' }),
            { ...createGrpcRequest('Old', { id: 'old', methodKind: 'server-streaming' }), orphaned: true },
          ],
        }),
      ],
      websocket: [createWsApi('Live', { id: 'W', requests: [createWsRequest('Socket', { id: 'socket' })] })],
    },
  };
}

function json(body: unknown, status = 200, headers: [string, string][] = []): AssertionSubject {
  return { protocol: 'rest', status, durationMs: 5, bodyText: JSON.stringify(body), bodyKind: 'json', headers };
}

/** A sender that answers each request id from `answers`, and records the scope each step was sent with. */
function sender(answers: Record<string, AssertionSubject | Error>): {
  send: SequenceStepSender;
  calls: { step: ResolvedStep; scope: PropertyMap }[];
} {
  const calls: { step: ResolvedStep; scope: PropertyMap }[] = [];
  const send: SequenceStepSender = (step, scope) => {
    calls.push({ step, scope });
    const answer = answers[step.step.requestId];
    if (answer === undefined) return Promise.reject(new Error(`no answer for ${step.step.requestId}`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ subject: answer, origin: 'https://shop.example.test' });
  };
  return { send, calls };
}

const steps = (...list: SequenceStep[]) => createSequence('Checkout', { id: 'S', steps: list });
const step = (requestId: string, input: Parameters<typeof createSequenceStep>[1] = {}) =>
  createSequenceStep(requestId, { id: `T-${requestId}`, ...input });

describe('runSequence', () => {
  it('passes each step exactly the values set by the steps before it', async () => {
    const { send, calls } = sender({
      login: json({ access_token: 'tok-123', user: { id: 7 } }, 200, [['X-Session', 'sess-1']]),
      cart: json({ id: 'c1' }, 201),
      pay: json({ ok: true }),
    });
    const result = await runSequence(
      steps(
        step('login', {
          transfers: [
            { name: 'token', from: 'body', language: 'jsonpath', expression: '$.access_token' },
            { name: 'session', from: 'header', header: 'x-session' },
            { name: 'code', from: 'status' },
          ],
        }),
        step('cart', { transfers: [{ name: 'cart', from: 'body', language: 'jsonpath', expression: '$.id' }] }),
        step('pay'),
      ),
      project(),
      send,
    );
    expect(result.outcome).toBe('passed');
    expect(calls.map((c) => c.scope)).toEqual([
      {},
      { token: 'tok-123', session: 'sess-1', code: '200' },
      { token: 'tok-123', session: 'sess-1', code: '200', cart: 'c1' },
    ]);
    expect(result.steps[0]?.transfers).toEqual([
      { name: 'token', outcome: 'set', secret: false, value: 'tok-123' },
      { name: 'session', outcome: 'set', secret: false, value: 'sess-1' },
      { name: 'code', outcome: 'set', secret: false, value: '200' },
    ]);
    expect(result.steps[0]).toMatchObject({ origin: 'https://shop.example.test', status: 200, name: 'Log in' });
  });

  it('lifts from XML with the response’s own prefixes when none are given', async () => {
    const xml = '<s:Envelope xmlns:s="urn:s"><s:Body><s:Id>42</s:Id></s:Body></s:Envelope>';
    const { send, calls } = sender({
      login: { protocol: 'soap', status: 200, durationMs: 1, bodyText: xml, bodyKind: 'xml' },
      pay: json({}),
    });
    await runSequence(
      steps(
        step('login', { transfers: [{ name: 'id', from: 'body', language: 'xpath', expression: 'string(//s:Id)' }] }),
        step('pay'),
      ),
      project(),
      send,
    );
    expect(calls[1]?.scope).toEqual({ id: '42' });
  });

  it('keeps a secret value out of the result and hands it to the masker', async () => {
    const masked: string[] = [];
    const { send, calls } = sender({ login: json({ token: 'tok-secret', echo: 'Bearer known-cred' }), pay: json({}) });
    const result = await runSequence(
      steps(
        step('login', {
          transfers: [
            { name: 'token', from: 'body', language: 'jsonpath', expression: '$.token', secret: true },
            { name: 'echo', from: 'body', language: 'jsonpath', expression: '$.echo' },
          ],
        }),
        step('pay'),
      ),
      project(),
      send,
      { onSecretValue: (v) => masked.push(v), containsKnownSecret: (v) => v.includes('known-cred') },
    );
    expect(masked).toEqual(['tok-secret', 'Bearer known-cred']);
    expect(result.steps[0]?.transfers).toEqual([
      { name: 'token', outcome: 'set', secret: true },
      { name: 'echo', outcome: 'set', secret: true },
    ]);
    expect(JSON.stringify(result)).not.toContain('tok-secret');
    expect(JSON.stringify(result)).not.toContain('known-cred');
    // The value still reaches the next step: masking is about output, not about the run.
    expect(calls[1]?.scope).toEqual({ token: 'tok-secret', echo: 'Bearer known-cred' });
  });

  it('errors a step whose required transfer finds nothing, and lets an optional one pass', async () => {
    const { send } = sender({ login: json({}), cart: json({}, 201) });
    const result = await runSequence(
      createSequence('S', {
        id: 'S',
        settings: { stopOnFailure: false },
        steps: [
          step('login', { transfers: [{ name: 'a', from: 'header', header: 'X-None', optional: true }] }),
          step('cart', { transfers: [{ name: 'b', from: 'body', language: 'jsonpath', expression: '$.missing' }] }),
        ],
      }),
      project(),
      send,
    );
    expect(result.steps.map((s) => s.outcome)).toEqual(['passed', 'errored']);
    expect(result.steps[1]?.error?.code).toBe('sequence-transfer-missing');
    expect(result.steps[0]?.transfers).toEqual([{ name: 'a', outcome: 'missing', secret: false }]);
  });

  it('refuses a value over the size limit', async () => {
    const { send } = sender({ login: json({ big: 'x'.repeat(SEQUENCE_LIMITS.valueBytes + 1) }) });
    const result = await runSequence(
      steps(step('login', { transfers: [{ name: 'big', from: 'body', language: 'jsonpath', expression: '$.big' }] })),
      project(),
      send,
    );
    expect(result.steps[0]).toMatchObject({ outcome: 'errored', error: { code: 'sequence-value-too-large' } });
  });

  it('runs the request’s own assertions first, unless the step turns them off', async () => {
    const { send } = sender({ cart: json({}, 200) });
    const on = await runSequence(steps(step('cart', { assertions: [{ type: 'sla', maxMs: 1000 }] })), project(), send);
    expect(on.steps[0]?.assertions.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'failed'],
      ['sla', 'passed'],
    ]);
    expect(on.outcome).toBe('failed');

    const off = await runSequence(steps(step('cart', { requestAssertions: false })), project(), send);
    expect(off.steps[0]?.assertions).toEqual([]);
    expect(off.outcome).toBe('passed');
  });

  it('skips the rest after a failure, unless stopOnFailure is off', async () => {
    const { send } = sender({ cart: json({}, 500), pay: json({}) });
    const stopped = await runSequence(steps(step('cart'), step('pay')), project(), send);
    expect(stopped.steps.map((s) => [s.outcome, s.skipped])).toEqual([
      ['failed', undefined],
      ['skipped', 'after-failure'],
    ]);

    const kept = await runSequence(
      createSequence('S', { id: 'S', settings: { stopOnFailure: false }, steps: [step('cart'), step('pay')] }),
      project(),
      send,
    );
    expect(kept.steps.map((s) => s.outcome)).toEqual(['failed', 'passed']);
  });

  it('skips a disabled step without stopping the run', async () => {
    const { send, calls } = sender({ login: json({}), pay: json({}) });
    const result = await runSequence(steps(step('login', { enabled: false }), step('pay')), project(), send);
    expect(result.steps.map((s) => [s.outcome, s.skipped])).toEqual([
      ['skipped', 'disabled'],
      ['passed', undefined],
    ]);
    expect(calls.map((c) => c.step.step.requestId)).toEqual(['pay']);
  });

  it('errors a missing and an orphaned step by name, and sends a WebSocket and a streaming gRPC one', async () => {
    const { send, calls } = sender({ socket: json([]), watch: json([]) });
    const result = await runSequence(
      createSequence('S', {
        id: 'S',
        settings: { stopOnFailure: false },
        steps: [step('gone'), step('socket'), step('watch'), step('old')],
      }),
      project(),
      send,
    );
    expect(result.steps.map((s) => s.error?.code)).toEqual([
      'sequence-step-missing-request',
      undefined,
      undefined,
      'sequence-step-unsupported',
    ]);
    expect(calls.map((c) => c.step.step.requestId)).toEqual(['socket', 'watch']);
  });

  it('turns a throwing sender into an errored step with the error’s code', async () => {
    const failure = Object.assign(new Error('refused'), { code: 'x' });
    const { send } = sender({ login: failure });
    const result = await runSequence(steps(step('login')), project(), send);
    expect(result.steps[0]).toMatchObject({
      outcome: 'errored',
      error: { code: 'internal-error', message: 'refused' },
    });
  });

  it('skips everything after an abort', async () => {
    const controller = new AbortController();
    const { send } = sender({ login: json({}), pay: json({}) });
    const wrapped: SequenceStepSender = async (s, scope, signal) => {
      const answer = await send(s, scope, signal);
      controller.abort();
      return answer;
    };
    const seen: string[] = [];
    const result = await runSequence(steps(step('login'), step('pay')), project(), wrapped, {
      signal: controller.signal,
      onStepDone: (r) => seen.push(`${r.index}:${r.outcome}`),
    });
    expect(result.steps.map((s) => [s.outcome, s.skipped])).toEqual([
      ['passed', undefined],
      ['skipped', 'cancelled'],
    ]);
    expect(seen).toEqual(['0:passed', '1:skipped']);
  });

  it('passes the sequence’s step timeout to the sender', async () => {
    const { send, calls } = sender({ login: json({}) });
    await runSequence(
      createSequence('S', { id: 'S', settings: { stopOnFailure: true, stepTimeoutMs: 1500 }, steps: [step('login')] }),
      project(),
      send,
    );
    expect(calls[0]?.step.timeoutMs).toBe(1500);
  });

  it('holds a transfer named like an object key as an ordinary value', async () => {
    const { send, calls } = sender({ login: json({ v: 'x' }), pay: json({}) });
    await runSequence(
      steps(
        step('login', { transfers: [{ name: '__proto__', from: 'body', language: 'jsonpath', expression: '$.v' }] }),
        step('pay'),
      ),
      project(),
      send,
    );
    expect(Object.hasOwn(calls[1]!.scope, '__proto__')).toBe(true);
    expect(calls[1]!.scope['__proto__']).toBe('x');
  });
  it("merges a step's script results: values for later steps, tests as assertions, a failure as an error", async () => {
    const calls: PropertyMap[] = [];
    const secrets: string[] = [];
    const send: SequenceStepSender = (resolved, scope) => {
      calls.push(scope);
      if (resolved.step.requestId === 'login') {
        return Promise.resolve({
          subject: json({ ok: true }),
          script: {
            tests: [{ name: 'logged in', passed: true }],
            values: [
              { name: 'token', value: 'tok-9', secret: true },
              { name: 'plain', value: 'p', secret: false },
            ],
            log: { lines: ['hello'], truncated: false },
          },
        });
      }
      return Promise.resolve({
        subject: json({ ok: true }),
        scriptsOff: true,
        script: {
          tests: [{ name: 'broke', passed: false, message: 'nope' }],
          values: [],
          log: { lines: [], truncated: false },
          error: { code: 'script-error', message: 'Pay.post.ts:1:1: Error: late' },
        },
      });
    };
    const result = await runSequence(steps(step('login'), step('pay')), project(), send, {
      onSecretValue: (v) => secrets.push(v),
    });
    expect(calls[1]).toEqual({ token: 'tok-9', plain: 'p' });
    expect(secrets).toEqual(['tok-9']);
    expect(result.steps[0]).toMatchObject({
      outcome: 'passed',
      assertions: [{ type: 'script', label: 'logged in', outcome: 'passed' }],
      scriptLog: ['hello'],
    });
    expect(result.steps[1]).toMatchObject({
      outcome: 'errored',
      error: { code: 'script-error' },
      assertions: [{ type: 'script', label: 'broke', outcome: 'failed', message: 'nope' }],
      scriptsOff: true,
    });
  });
});
