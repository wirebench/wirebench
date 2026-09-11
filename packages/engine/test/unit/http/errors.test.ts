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

  it.each(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])(
    'maps %s to tls-untrusted',
    (code) => {
      const err = toHttpError(codedError(code), { userAborted: false, deadlineHit: false });
      expect(err.code).toBe('tls-untrusted');
      expect(err.details).toEqual({ code });
      expect(err.message).toContain('not trusted');
      expect(err.message).toContain('CA bundle');
    },
  );

  it('names the peer subject when Node attached the offending certificate', () => {
    const cause = Object.assign(codedError('SELF_SIGNED_CERT_IN_CHAIN'), {
      cert: { subject: { CN: 'private.corp.test', O: 'Corp' } },
    });
    const err = toHttpError(cause, { userAborted: false, deadlineHit: false, host: 'private.corp.test:443' });
    expect(err.details?.['peerSubject']).toBe('CN=private.corp.test, O=Corp');
    expect(err.details?.['host']).toBe('private.corp.test:443');
    expect(err.message).toContain('CN=private.corp.test, O=Corp');
  });

  it('finds the certificate through a cause chain', () => {
    const inner = Object.assign(codedError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), {
      cert: { subject: { CN: 'leaf.test' } },
    });
    const err = toHttpError(new Error('wrapped', { cause: inner }), { userAborted: false, deadlineHit: false });
    // The outer error carries no code of its own, so this stays a generic network failure — but
    // when the code *is* the untrusted one, the walk still reaches the certificate.
    expect(toHttpError(inner, { userAborted: false, deadlineHit: false }).details?.['peerSubject']).toBe(
      'CN=leaf.test',
    );
    expect(err.code).toBe('network');
  });

  it('keeps a handshake failure on the generic tls code', () => {
    const err = toHttpError(codedError('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION'), {
      userAborted: false,
      deadlineHit: false,
    });
    expect(err.code).toBe('tls');
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
