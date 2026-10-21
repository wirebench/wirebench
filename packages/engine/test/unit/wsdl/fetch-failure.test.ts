import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { describeFetchFailure } from '../../../src/wsdl/fetch-failure.js';

const URL = 'http://svc.example.test/calc?wsdl';

/** What global fetch throws for a transport failure: a TypeError whose cause carries Node's code. */
function fetchFailed(code: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('describeFetchFailure (#732 X14)', () => {
  it('names the HTTP status and what to try', () => {
    const notFound = new HttpError('fetch-failed', 'GET … failed with status 404', { details: { status: 404 } });
    expect(describeFetchFailure(notFound, URL)).toBe(
      `The server answered 404 Not Found for ${URL}. Check the URL: a service's WSDL is often at its address with ?wsdl.`,
    );
    const unauthorized = new HttpError('definition-auth-required', 'x', { details: { status: 401 } });
    expect(describeFetchFailure(unauthorized, URL)).toContain('401 Unauthorized: it wants a sign-in');
    const down = new HttpError('fetch-failed', 'x', { details: { status: 503 } });
    expect(describeFetchFailure(down, URL)).toContain('503 Service Unavailable. The service may be down');
  });

  it('names a DNS, refused, timed-out or TLS failure with the host', () => {
    expect(describeFetchFailure(fetchFailed('ENOTFOUND'), URL)).toBe(
      'svc.example.test could not be found. Check the address, or whether a VPN is needed.',
    );
    expect(describeFetchFailure(fetchFailed('ECONNREFUSED'), URL)).toContain('Nothing answered at svc.example.test');
    expect(describeFetchFailure(new HttpError('timeout', 'The request timed out.'), URL)).toContain(
      'did not answer in time',
    );
    expect(describeFetchFailure(fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'), URL)).toContain('is not trusted');
  });

  it('names a missing file', () => {
    const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    expect(describeFetchFailure(missing, 'file:///tmp/none.wsdl')).toBe('There is no file at file:///tmp/none.wsdl.');
  });
});
