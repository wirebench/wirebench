// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { failedExchangeOf } from '../src/main/failed-exchange.js';

const STARTED_AT = Date.parse('2026-09-16T08:30:05.000Z');

function input(overrides: Partial<Parameters<typeof failedExchangeOf>[0]> = {}) {
  return {
    sendId: 'send-1',
    protocol: 'soap' as const,
    requestId: 'req-1',
    url: 'https://example.test/calc.asmx',
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=' },
    startedAt: STARTED_AT,
    durationMs: 42,
    error: new WirebenchError('connection-refused', 'Connection refused.'),
    ...overrides,
  };
}

describe('failedExchangeOf', () => {
  it('copies the identity, the timing and the request as sent', () => {
    const failure = failedExchangeOf(input());

    expect(failure).toMatchObject({
      sendId: 'send-1',
      protocol: 'soap',
      requestId: 'req-1',
      request: { url: 'https://example.test/calc.asmx', method: 'POST' },
      startedAt: '2026-09-16T08:30:05.000Z',
      durationMs: 42,
    });
  });

  it('redacts sensitive headers unconditionally and keeps the others', () => {
    const failure = failedExchangeOf(
      input({
        headers: {
          'Content-Type': 'text/xml',
          Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=',
          Cookie: 'sid=1',
          'X-Api-Key': 'k',
        },
      }),
    );

    expect(failure.request.headers).toEqual({
      'Content-Type': 'text/xml',
      Authorization: '<redacted>',
      Cookie: '<redacted>',
      'X-Api-Key': '<redacted>',
    });
    expect(JSON.stringify(failure)).not.toContain('dG9wc2VjcmV0');
  });

  it('masks a sensitive query parameter in the URL, including the API key parameter it is told about', () => {
    const failure = failedExchangeOf(
      input({ url: 'https://api.test/pets?token=abc&secretish=xyz&page=2', keyParams: ['secretish'] }),
    );

    expect(failure.request.url).toBe('https://api.test/pets?token=%3Credacted%3E&secretish=%3Credacted%3E&page=2');
  });

  it('maps a WirebenchError to its code and message', () => {
    const failure = failedExchangeOf(input({ error: new WirebenchError('dns', 'DNS lookup failed.') }));

    expect(failure.error).toEqual({ code: 'dns', message: 'DNS lookup failed.' });
  });

  it('maps anything else to internal-error with the message it has', () => {
    expect(failedExchangeOf(input({ error: new Error('boom') })).error).toEqual({
      code: 'internal-error',
      message: 'boom',
    });
    expect(failedExchangeOf(input({ error: 'plain string' })).error).toEqual({
      code: 'internal-error',
      message: 'plain string',
    });
  });

  it('omits requestId for an ad-hoc send rather than writing undefined', () => {
    const failure = failedExchangeOf(input({ requestId: undefined }));

    expect(failure).not.toHaveProperty('requestId');
  });
});
