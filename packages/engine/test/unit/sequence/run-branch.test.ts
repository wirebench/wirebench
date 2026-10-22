/**
 * Branches in a run (#347): repeat, go to and skip next, each loop bounded by its own `max` and the run
 * by `SEQUENCE_LIMITS.stepRuns`; only the last run of each step counts; a branch wins over
 * stop-on-failure.
 */
import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '#core/assert/model';
import { createProject } from '#core/project/model';
import type { Project } from '#core/project/model';
import { createApi, createRestRequest } from '#protocol-rest/rest/model';
import { createSequence, createSequenceStep, SEQUENCE_LIMITS } from '#core/sequence/model';
import type { BranchRule, SequenceStep } from '#core/sequence/model';
import { runSequence } from '#core/sequence/run';
import type { ResolvedStep, SequenceStepSender } from '#core/sequence/run';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

function project(): Project {
  return {
    ...createProject('P', { id: 'P' }),
    containers: {
      rest: [
        createApi('Jobs', {
          id: 'A',
          requests: ['start', 'poll', 'report', 'fallback', 'done'].map((id) => createRestRequest(id, { id })),
        }),
      ],
    },
  };
}

function json(body: unknown, status = 200): AssertionSubject {
  return { protocol: 'rest', status, durationMs: 1, bodyText: JSON.stringify(body), bodyKind: 'json', headers: [] };
}

/** Answers each request id from its queue in turn, the last answer repeating; records every send. */
function sender(answers: Record<string, readonly (AssertionSubject | Error)[]>): {
  send: SequenceStepSender;
  sent: ResolvedStep[];
} {
  const sent: ResolvedStep[] = [];
  const counts = new Map<string, number>();
  const send: SequenceStepSender = (step) => {
    sent.push(step);
    const queue = answers[step.step.requestId] ?? [json({})];
    const n = counts.get(step.step.requestId) ?? 0;
    counts.set(step.step.requestId, n + 1);
    const answer = queue[Math.min(n, queue.length - 1)]!;
    if (answer instanceof Error) return Promise.resolve({ error: { code: 'send-failed', message: answer.message } });
    return Promise.resolve({ subject: answer });
  };
  return { send, sent };
}

const step = (requestId: string, input: Parameters<typeof createSequenceStep>[1] = {}): SequenceStep =>
  createSequenceStep(requestId, { id: `T-${requestId}`, ...input });
const sequence = (...steps: SequenceStep[]) => createSequence('Jobs', { id: 'S', steps });

const notDone: BranchRule = {
  when: { type: 'match', language: 'jsonpath', expression: '$.state', equals: 'done', not: true },
  then: 'repeat',
  max: 5,
};
const doneAssertion = { type: 'match', language: 'jsonpath', expression: '$.state', equals: 'done' } as const;

describe('runSequence with branches', () => {
  it('repeats a step until its condition stops holding, and counts only the last run', async () => {
    const { send, sent } = sender({
      poll: [json({ state: 'running' }), json({ state: 'running' }), json({ state: 'done' })],
    });
    const result = await runSequence(
      sequence(step('start'), step('poll', { assertions: [doneAssertion], branches: [notDone] }), step('done')),
      project(),
      send,
    );
    expect(sent.map((s) => `${s.step.requestId}#${s.attempt}`)).toEqual([
      'start#1',
      'poll#1',
      'poll#2',
      'poll#3',
      'done#1',
    ]);
    expect(result.outcome).toBe('passed');
    const polls = result.steps.filter((s) => s.stepId === 'T-poll');
    expect(polls.map((s) => [s.outcome, s.attempt, s.retried])).toEqual([
      ['failed', undefined, true],
      ['failed', 2, true],
      ['passed', 3, undefined],
    ]);
    expect(polls[0]?.branch).toEqual({
      rule: 0,
      action: 'repeat',
      to: { index: 1, stepId: 'T-poll', name: 'poll' },
      count: 1,
      max: 5,
    });
    expect(polls[2]?.branch).toBeUndefined();
  });

  it('marks a repeated run retried as it is reported, not only at the end', async () => {
    const { send } = sender({ poll: [json({ state: 'running' }), json({ state: 'done' })] });
    const emitted: (boolean | undefined)[] = [];
    await runSequence(sequence(step('poll', { branches: [notDone] })), project(), send, {
      onStepDone: (result) => emitted.push(result.retried),
    });
    expect(emitted).toEqual([true, undefined]);
  });

  it('carries on when a loop reaches its max, and the last attempt’s outcome stands', async () => {
    const { send, sent } = sender({ poll: [json({ state: 'running' })] });
    // Under stop-on-failure, the run stops after the last attempt fails.
    const result = await runSequence(
      sequence(step('poll', { assertions: [doneAssertion], branches: [{ ...notDone, max: 2 }] }), step('done')),
      project(),
      send,
    );
    expect(sent.map((s) => s.step.requestId)).toEqual(['poll', 'poll', 'poll']);
    const last = result.steps.filter((s) => s.stepId === 'T-poll').at(-1);
    expect(last).toMatchObject({ outcome: 'failed', attempt: 3 });
    expect(last?.branch).toEqual({
      rule: 0,
      action: 'repeat',
      to: { index: 0, stepId: 'T-poll', name: 'poll' },
      count: 2,
      max: 2,
      limitReached: true,
    });
    expect(result.steps.at(-1)).toMatchObject({ stepId: 'T-done', outcome: 'skipped', skipped: 'after-failure' });
    expect(result.outcome).toBe('failed');
  });

  it('goes to a fallback on a send error, over stop-on-failure, and still counts the failure', async () => {
    const { send, sent } = sender({ start: [new Error('connection refused')] });
    const result = await runSequence(
      sequence(
        step('start', {
          branches: [{ when: { type: 'outcome', equals: 'errored' }, then: 'goto', step: 'T-fallback', max: 1 }],
        }),
        step('report'),
        step('fallback'),
      ),
      project(),
      send,
    );
    expect(sent.map((s) => s.step.requestId)).toEqual(['start', 'fallback']);
    expect(result.steps.map((s) => [s.stepId, s.outcome, s.skipped])).toEqual([
      ['T-start', 'errored', undefined],
      ['T-report', 'skipped', 'branch'],
      ['T-fallback', 'passed', undefined],
    ]);
    expect(result.steps[0]?.branch).toMatchObject({ action: 'goto', to: { index: 2, stepId: 'T-fallback' } });
    expect(result.outcome).toBe('errored');
  });

  it('skips the next step, and only a check that holds fires a rule', async () => {
    const { send, sent } = sender({ start: [json({}, 404)] });
    const result = await runSequence(
      sequence(
        step('start', {
          branches: [
            { when: { type: 'status', equals: 200 }, then: 'goto', step: 'T-done', max: 1 },
            {
              when: { type: 'match', language: 'xpath', expression: '/a', exists: true },
              then: 'goto',
              step: 'T-done',
              max: 1,
            },
            { when: { type: 'status', equals: '4xx' }, then: 'skip-next' },
          ],
        }),
        step('report'),
        step('done'),
      ),
      project(),
      send,
    );
    expect(sent.map((s) => s.step.requestId)).toEqual(['start', 'done']);
    expect(result.steps[0]?.branch).toEqual({ rule: 2, action: 'skip-next', count: 1 });
    // A step passed over keeps its protocol, so a report can place it like any other.
    expect(result.steps[1]).toMatchObject({
      stepId: 'T-report',
      protocol: 'rest',
      outcome: 'skipped',
      skipped: 'branch',
    });
  });

  it('loops back over several steps, retrying each of them', async () => {
    const { send, sent } = sender({ report: [json({ state: 'running' }), json({ state: 'done' })] });
    const result = await runSequence(
      sequence(
        step('start'),
        step('poll'),
        step('report', { branches: [{ when: notDone.when, then: 'goto', step: 'T-poll', max: 3 }] }),
      ),
      project(),
      send,
    );
    expect(sent.map((s) => s.step.requestId)).toEqual(['start', 'poll', 'report', 'poll', 'report']);
    expect(result.steps.map((s) => [s.stepId, s.retried === true])).toEqual([
      ['T-start', false],
      ['T-poll', true],
      ['T-report', true],
      ['T-poll', false],
      ['T-report', false],
    ]);
  });

  it('ends a run that reaches the run limit, erroring the step that would run next', async () => {
    const { send, sent } = sender({});
    // A body of 12 steps looped 100 times would be 1212 step runs without the run limit.
    const body = Array.from({ length: 11 }, (_, n) => createSequenceStep('poll', { id: `B${n}` }));
    const result = await runSequence(
      sequence(
        step('start'),
        ...body,
        step('report', {
          branches: [{ when: { type: 'status', equals: 200 }, then: 'goto', step: 'T-start', max: 100 }],
        }),
      ),
      project(),
      send,
    );
    expect(sent.length).toBe(SEQUENCE_LIMITS.stepRuns);
    expect(result.steps.at(-1)).toMatchObject({ outcome: 'errored', error: { code: 'sequence-run-limit' } });
    expect(result.outcome).toBe('errored');
  });

  it('waits before a jump, and a cancel during the wait skips the rest', async () => {
    const controller = new AbortController();
    const { send, sent } = sender({ poll: [json({ state: 'running' })] });
    const running = runSequence(
      sequence(step('poll', { branches: [{ ...notDone, delayMs: 60_000 }] }), step('done')),
      project(),
      send,
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;
    expect(sent.map((s) => s.step.requestId)).toEqual(['poll']);
    expect(result.steps.slice(1).map((s) => [s.stepId, s.skipped])).toEqual([
      ['T-poll', 'cancelled'],
      ['T-done', 'cancelled'],
    ]);
  });

  it('never branches from a disabled step', async () => {
    const { send, sent } = sender({});
    await runSequence(
      sequence(
        step('start', {
          enabled: false,
          branches: [{ when: { type: 'outcome', equals: ['passed', 'failed', 'errored'] }, then: 'skip-next' }],
        }),
        step('done'),
      ),
      project(),
      send,
    );
    expect(sent.map((s) => s.step.requestId)).toEqual(['done']);
  });
});
