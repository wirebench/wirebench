/**
 * The `sequences` feature (feature switches spec §2, §7): `runSequence` refuses with `feature-disabled`
 * before any step is looked at when its registry has the feature off, and runs as before with it on.
 */
import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '#core/assert/model';
import { createProject } from '#core/project/model';
import type { Project } from '#core/project/model';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '#protocol-rest/rest/model';
import { createSequence, createSequenceStep } from '#core/sequence/model';
import { runSequence } from '#core/sequence/run';
import type { SequenceStepSender } from '#core/sequence/run';

function project(): Project {
  return {
    ...createProject('P', { id: 'P' }),
    containers: {
      rest: [createApi('Shop', { id: 'A', requests: [createRestRequest('Log in', { id: 'login' })] })],
    },
  };
}

const sequence = createSequence('Checkout', { id: 'S', steps: [createSequenceStep('login', { id: 'T-login' })] });

/** A sender that counts its calls and answers every step with a 200. */
function sender(): { send: SequenceStepSender; calls: () => number } {
  let calls = 0;
  const subject: AssertionSubject = {
    protocol: 'rest',
    status: 200,
    durationMs: 1,
    bodyText: '{}',
    bodyKind: 'json',
    headers: [],
  };
  return {
    send: () => {
      calls += 1;
      return Promise.resolve({ subject, origin: 'https://shop.example.test' });
    },
    calls: () => calls,
  };
}

describe('the sequences feature', () => {
  it('off: runSequence throws feature-disabled and sends no step', async () => {
    const { send, calls } = sender();
    const steps: string[] = [];
    await expect(
      runSequence(sequence, project(), send, {
        registry: createBuiltinRegistry({ sequences: false }),
        onStepDone: (step) => steps.push(step.stepId),
      }),
    ).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'feature-disabled',
      message: 'Sequences is switched off',
      details: { feature: 'sequences' },
    });
    expect(calls()).toBe(0);
    expect(steps).toEqual([]);
  });

  it('on: the sequence runs', async () => {
    const { send, calls } = sender();
    const result = await runSequence(sequence, project(), send, { registry: createBuiltinRegistry() });
    expect(result.outcome).toBe('passed');
    expect(calls()).toBe(1);
  });

  it('with no registry, the built-in one (every feature on) decides', async () => {
    const { send, calls } = sender();
    const result = await runSequence(sequence, project(), send);
    expect(result.outcome).toBe('passed');
    expect(calls()).toBe(1);
  });
});
