import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const grpcSubject = (over: Partial<AssertionSubject> = {}): AssertionSubject => ({
  protocol: 'grpc',
  status: 0,
  durationMs: 120,
  bodyText: '{}',
  bodyKind: 'json',
  ...over,
});

describe('status on a gRPC subject', () => {
  it('passes and fails by code', async () => {
    const [pass] = await evaluateAssertions(grpcSubject({ status: 5 }), [{ type: 'status', equals: 5 }]);
    const [fail] = await evaluateAssertions(grpcSubject({ status: 5 }), [{ type: 'status', equals: 0 }]);
    expect(pass!.outcome).toBe('passed');
    expect(fail!.outcome).toBe('failed');
  });

  it('passes and fails by name', async () => {
    const [pass] = await evaluateAssertions(grpcSubject({ status: 5 }), [{ type: 'status', equals: 'NOT_FOUND' }]);
    const [fail] = await evaluateAssertions(grpcSubject({ status: 5 }), [{ type: 'status', equals: 'OK' }]);
    expect(pass!.outcome).toBe('passed');
    expect(fail!.outcome).toBe('failed');
  });

  it('passes a mixed list of codes and names', async () => {
    const [r] = await evaluateAssertions(grpcSubject({ status: 5 }), [{ type: 'status', equals: [0, 'NOT_FOUND'] }]);
    expect(r!.outcome).toBe('passed');
  });

  it('errors on an unknown name', async () => {
    const [r] = await evaluateAssertions(grpcSubject({ status: 5 }), [{ type: 'status', equals: 'NOPE' }]);
    expect(r!.outcome).toBe('errored');
  });
});

describe('status name on a non-gRPC subject', () => {
  it('errors', async () => {
    const rest: AssertionSubject = {
      protocol: 'rest',
      status: 200,
      durationMs: 120,
      bodyText: '{}',
      bodyKind: 'json',
    };
    const [r] = await evaluateAssertions(rest, [{ type: 'status', equals: 'NOT_FOUND' }]);
    expect(r!.outcome).toBe('errored');
  });

  it('a numeric code keeps its HTTP meaning', async () => {
    const rest: AssertionSubject = {
      protocol: 'rest',
      status: 404,
      durationMs: 120,
      bodyText: '{}',
      bodyKind: 'json',
    };
    const [r] = await evaluateAssertions(rest, [{ type: 'status', equals: 404 }]);
    expect(r!.outcome).toBe('passed');
  });
});
