/**
 * Checking REST responses off the calling thread, each under a hard deadline.
 */
import { describe, expect, it } from 'vitest';
import type { RestContractInput } from '../../../src/rest/contract-check.js';
import { createRestContractChecker, DEFAULT_REST_CHECK_QUEUE } from '../../../src/rest/contract-check-worker-host.js';
import type { OpenApiResponses } from '../../../src/rest/openapi/model.js';

const hanging = new URL('../../fixtures/rest/hanging-contract-worker.mjs', import.meta.url);
const operation = { method: 'get', path: '/pets/{id}' };
const pet: Record<string, unknown> = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } },
};
// A shared, self-referencing schema: structured clone carries it; JSON would not.
(pet['properties'] as Record<string, unknown>)['parent'] = pet;
const responses: OpenApiResponses = { '200': { content: { 'application/json': { schema: pet } } } };
const input = (bodyText: string): RestContractInput => ({
  status: 200,
  contentType: 'application/json',
  bodyText,
  language: 'json',
  streamed: false,
  operation,
  responses,
});

describe('createRestContractChecker', () => {
  it('checks a response off the main thread, cyclic schema included', async () => {
    const checker = createRestContractChecker();
    try {
      expect(await checker.check(input('{"id":1,"parent":{"id":2}}'))).toMatchObject({
        status: 'ok',
        operation,
        responseKey: '200',
      });
      const bad = await checker.check(input('{"id":"x"}'));
      expect(bad.status).toBe('violation');
      expect(bad.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/id' })]));
      expect(checker.spawned).toBe(1);
    } finally {
      await checker.dispose();
    }
  });

  it('marks a check that outruns the deadline not-checked, and a fresh worker takes the next', async () => {
    const checker = createRestContractChecker({ workerUrl: hanging, deadlineMs: 600 });
    try {
      const started = Date.now();
      const stuck = await checker.check(input('hang'));
      expect(stuck).toMatchObject({ status: 'not-checked', problems: [] });
      expect(stuck.notes[0]).toMatch(/longer than 600 ms/);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await checker.check(input('{}'))).toMatchObject({ status: 'ok', notes: ['stub'] });
      expect(checker.spawned).toBe(2);
    } finally {
      await checker.dispose();
    }
  });

  it('a full queue answers not-checked instead of growing without bound', async () => {
    expect(DEFAULT_REST_CHECK_QUEUE).toBe(16);
    const checker = createRestContractChecker({ workerUrl: hanging, deadlineMs: 10_000 });
    const first = checker.check(input('hang'));
    const waiting = Array.from({ length: 16 }, () => checker.check(input('{}')));
    expect(await checker.check(input('{}'))).toMatchObject({ status: 'not-checked' });
    await checker.dispose();
    await Promise.all([first, ...waiting]);
  });

  it('dispose stops the worker, answers what was waiting, and refuses later checks', async () => {
    const checker = createRestContractChecker({ workerUrl: hanging, deadlineMs: 10_000 });
    const pending = checker.check(input('hang'));
    const queued = checker.check(input('{}'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checker.running).toBe(true);
    await checker.dispose();
    expect(checker.running).toBe(false);
    expect(await pending).toMatchObject({ status: 'not-checked' });
    expect(await queued).toMatchObject({ status: 'not-checked' });
    expect(await checker.check(input('{}'))).toMatchObject({ status: 'not-checked' });
  });
});
