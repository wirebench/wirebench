import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { grpcStatusNames } from '../../../src/grpc/status.js';

const grpcSubject = (over: Partial<AssertionSubject> = {}): AssertionSubject => ({
  protocol: 'grpc',
  status: 0,
  durationMs: 120,
  bodyText: '{}',
  bodyKind: 'json',
  statusNames: grpcStatusNames,
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

  it('errors on a low numeric value that cannot be an HTTP status (a typo for 404)', async () => {
    const rest: AssertionSubject = {
      protocol: 'rest',
      status: 404,
      durationMs: 120,
      bodyText: '{}',
      bodyKind: 'json',
    };
    const [r] = await evaluateAssertions(rest, [{ type: 'status', equals: 4 }]);
    expect(r!.outcome).toBe('errored');
    expect(r!.message).toContain('4 is not an HTTP status');
  });

  it('errors the same way on a SOAP subject', async () => {
    const soap: AssertionSubject = {
      protocol: 'soap',
      status: 200,
      durationMs: 120,
      bodyText: '<a/>',
      bodyKind: 'xml',
    };
    const [r] = await evaluateAssertions(soap, [{ type: 'status', equals: 4 }]);
    expect(r!.outcome).toBe('errored');
  });
});

describe('status names come from the subject, whatever its protocol', () => {
  const subject: AssertionSubject = {
    protocol: 'echo',
    status: 2,
    durationMs: 1,
    bodyText: '',
    bodyKind: 'other',
    statusNames: {
      byName: new Map([
        ['READY', 1],
        ['BUSY', 2],
      ]),
      nameOf: (code) => (code === 1 ? 'READY' : code === 2 ? 'BUSY' : `UNKNOWN (${String(code)})`),
    },
  };

  it('passes by name and by exact code', async () => {
    const [byName, byCode] = await evaluateAssertions(subject, [
      { type: 'status', equals: 'BUSY' },
      { type: 'status', equals: 2 },
    ]);
    expect(byName?.outcome).toBe('passed');
    expect(byCode?.outcome).toBe('passed');
  });

  it('fails with the name of the status it got', async () => {
    const [failed] = await evaluateAssertions(subject, [{ type: 'status', equals: 'READY' }]);
    expect(failed).toMatchObject({ outcome: 'failed', expected: 'READY', actual: 'BUSY' });
  });

  it('errors on a name the subject does not have, and on an HTTP class', async () => {
    const [unknown, httpClass] = await evaluateAssertions(subject, [
      { type: 'status', equals: 'NOT_FOUND' },
      { type: 'status', equals: '2xx' },
    ]);
    expect(unknown?.outcome).toBe('errored');
    expect(httpClass?.outcome).toBe('errored');
  });

  it('a subject without names gets the HTTP rules, whatever it calls its protocol', async () => {
    const bare: AssertionSubject = { protocol: 'grpc', status: 5, durationMs: 1, bodyText: '', bodyKind: 'other' };
    const [low] = await evaluateAssertions(bare, [{ type: 'status', equals: 5 }]);
    expect(low).toMatchObject({ outcome: 'errored', message: '5 is not an HTTP status' });
  });
});
