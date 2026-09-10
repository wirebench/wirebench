import { describe, expect, it } from 'vitest';
import { toHttpError } from '../../../src/http/errors.js';

function codedError(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

describe('toHttpError', () => {
  it('maps a deadline hit to timeout', () => {
    const err = toHttpError(new Error('boom'), { userAborted: false, deadlineHit: true });
    expect(err.code).toBe('timeout');
  });

  it('maps a user abort to aborted', () => {
    const err = toHttpError(new Error('boom'), { userAborted: true, deadlineHit: false });
    expect(err.code).toBe('aborted');
  });

  it('maps AbortError by name to aborted', () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const err = toHttpError(abortErr, { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('aborted');
  });

  it('maps ENOTFOUND to dns', () => {
    const err = toHttpError(codedError('ENOTFOUND'), { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('dns');
  });

  it('maps EAI_AGAIN to dns', () => {
    const err = toHttpError(codedError('EAI_AGAIN'), { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('dns');
  });

  it('maps a certificate error code to tls', () => {
    const err = toHttpError(codedError('DEPTH_ZERO_SELF_SIGNED_CERT'), { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('tls');
    expect(err.details).toEqual({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it('maps an ERR_TLS_* code to tls', () => {
    const err = toHttpError(codedError('ERR_TLS_CERT_ALTNAME_INVALID'), { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('tls');
  });

  it('falls back to network for an unrecognized error with no code', () => {
    const err = toHttpError(new Error('mystery'), { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('network');
    expect(err.message).toBe('mystery');
    expect(err.details).toBeUndefined();
  });

  it('falls back to network for a non-Error thrown value', () => {
    const err = toHttpError('a string was thrown', { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('network');
    expect(err.message).toBe('Network error.');
  });

  it('maps ECONNREFUSED to proxy when the request used a proxy', () => {
    const err = toHttpError(codedError('ECONNREFUSED'), { userAborted: false, deadlineHit: false, hadProxy: true });
    expect(err.code).toBe('proxy');
    expect(err.details).toEqual({ code: 'ECONNREFUSED' });
  });

  it('maps ECONNREFUSED to connection-refused when no proxy was used', () => {
    const err = toHttpError(codedError('ECONNREFUSED'), { userAborted: false, deadlineHit: false });
    expect(err.code).toBe('connection-refused');
  });

  it('maps an undici proxy-named error to proxy when the request used a proxy', () => {
    const proxyErr = new Error('Proxy connection failed');
    proxyErr.name = 'ProxyError';
    const err = toHttpError(proxyErr, { userAborted: false, deadlineHit: false, hadProxy: true });
    expect(err.code).toBe('proxy');
  });
});
