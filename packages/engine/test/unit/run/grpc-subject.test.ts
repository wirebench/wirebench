/**
 * What assertions see of a gRPC call's answer when there is no JSON to read: a response message
 * that did not decode, or none at all. Either leaves the body `other`, and a `match` errors on it
 * rather than failing, since "could not tell" is not "wrong".
 */
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { GrpcCallResult, GrpcResponseMessage } from '../../../src/grpc/call.js';
import type { GrpcExchange } from '../../../src/grpc/send.js';
import { grpcSubject } from '../../../src/run/run.js';

function result(messages: readonly GrpcResponseMessage[], status = 0): GrpcCallResult {
  return {
    exchange: { status, durationMs: 12 } as unknown as GrpcExchange,
    methodKind: 'unary',
    requestType: 'a.Req',
    responseType: 'a.Res',
    requestMessages: [{}],
    responseMessages: messages,
  };
}

const MATCH = { type: 'match', language: 'jsonpath', expression: '$.message', exists: true } as const;

describe('grpcSubject', () => {
  it('reads a decoded message as JSON', () => {
    expect(grpcSubject(result([{ json: { message: 'hi' }, base64: '', bytes: 4 }]))).toEqual({
      protocol: 'grpc',
      status: 0,
      durationMs: 12,
      bodyText: '{"message":"hi"}',
      bodyKind: 'json',
    });
  });

  it.each([
    ['a message that did not decode', [{ base64: 'AAE=', bytes: 2, problem: 'bad wire type' }]],
    ['no message at all', []],
  ])('leaves the body other for %s, and a match errors', async (_label, messages) => {
    const subject = grpcSubject(result(messages, 5));
    expect(subject).toMatchObject({ status: 5, bodyText: '', bodyKind: 'other' });
    const [match] = await evaluateAssertions(subject, [MATCH]);
    expect(match).toMatchObject({ outcome: 'errored' });
    expect(match?.message).toBeDefined();
  });
});
