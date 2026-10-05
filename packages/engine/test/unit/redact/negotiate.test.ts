import { describe, expect, it } from 'vitest';
import { maskNegotiateTokens, redactHeaderPairs, redactHeaders, redactRawHttp } from '../../../src/redact/index.js';

describe('Negotiate tokens', () => {
  it('masks Authorization: Negotiate whole, as every Authorization is', () => {
    expect(redactHeaders({ Authorization: 'Negotiate YIIB' })).toEqual({ Authorization: '<redacted>' });
  });

  it('masks the token in WWW-Authenticate and keeps the rest of the challenge readable', () => {
    expect(maskNegotiateTokens('Negotiate oYG0MIGxoAMKAQA=, Basic realm="x"')).toBe(
      'Negotiate <redacted>, Basic realm="x"',
    );
    expect(maskNegotiateTokens('Basic realm="x", Negotiate oYG0')).toBe('Basic realm="x", Negotiate <redacted>');
    expect(maskNegotiateTokens('Negotiate')).toBe('Negotiate');
    expect(redactHeaders({ 'www-authenticate': 'Negotiate oYG0' })).toEqual({
      'www-authenticate': 'Negotiate <redacted>',
    });
  });

  it('masks it in a header pair list, and in Proxy-Authenticate', () => {
    expect(
      redactHeaderPairs([
        ['WWW-Authenticate', 'Negotiate oYG0'],
        ['Proxy-Authenticate', 'Negotiate abc123=='],
        ['Server', 'Negotiate-not'],
      ]),
    ).toEqual([
      ['WWW-Authenticate', 'Negotiate <redacted>'],
      ['Proxy-Authenticate', 'Negotiate <redacted>'],
      ['Server', 'Negotiate-not'],
    ]);
    expect(redactHeaders({ 'Proxy-Authenticate': 'Negotiate oYG0' })).toEqual({
      'Proxy-Authenticate': 'Negotiate <redacted>',
    });
  });

  it('masks it in raw HTTP too', () => {
    const raw = 'HTTP/1.1 200 OK\r\nWWW-Authenticate: Negotiate oYG0MIGx\r\n\r\nok';
    expect(redactRawHttp(raw)).toContain('WWW-Authenticate: Negotiate <redacted>');
    expect(redactRawHttp(raw)).not.toContain('oYG0MIGx');
  });
});
