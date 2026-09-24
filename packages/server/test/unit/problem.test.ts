import { describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { z } from 'zod';
import { problem, toProblem } from '../../src/problem.js';

describe('toProblem', () => {
  it('maps a WirebenchError to its status and code, default 500', () => {
    expect(toProblem(problem('server-x', 'nope', 409))).toEqual({
      status: 409,
      body: { code: 'server-x', message: 'nope' },
    });
    expect(toProblem(new WirebenchError('server-y', 'y'))).toEqual({
      status: 500,
      body: { code: 'server-y', message: 'y' },
    });
  });
  it('maps a zod error to 400 invalid-request with paths', () => {
    const result = z.object({ name: z.string() }).safeParse({});
    const mapped = toProblem(result.success ? new Error() : result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe('invalid-request');
    expect(mapped.body.issues?.[0]?.path).toBe('name');
  });
  it('hides everything about an unknown error', () => {
    const mapped = toProblem(new Error('ECONNREFUSED postgres://secret@db'));
    expect(mapped).toEqual({ status: 500, body: { code: 'internal', message: 'Internal error' } });
  });
  it('never leaks details other than status into the body', () => {
    const mapped = toProblem(problem('server-x', 'x', 400, { path: '/data/repos' }));
    expect(JSON.stringify(mapped.body)).not.toContain('/data');
  });
});
