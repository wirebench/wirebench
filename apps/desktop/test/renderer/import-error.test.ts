import { describe, expect, it } from 'vitest';
import { describeImportError } from '../../src/renderer/features/explorer/import-error.js';

const URL = 'https://api.example.test/openapi.json';

/** What main's fetcher throws, as the IPC bridge rebuilds it: the status in the message and on `details`. */
function failed(status: number, details = true): Error {
  const error = new Error(`GET ${URL} failed with status ${String(status)}`);
  return details ? Object.assign(error, { details: { status } }) : error;
}

describe('describeImportError (#685 E15)', () => {
  it('names the status, its reason and the host, and says what to check', () => {
    expect(describeImportError(failed(404), URL)).toBe(
      `The server answered 404 Not Found from api.example.test. Check the URL: there is no document at ${URL}.`,
    );
    expect(describeImportError(failed(401), URL)).toContain(
      '401 Unauthorized from api.example.test: it wants a sign-in',
    );
    expect(describeImportError(failed(503), URL)).toContain(
      '503 Service Unavailable from api.example.test. The service may be down',
    );
    expect(describeImportError(failed(418), URL)).toBe(
      'The server answered 418 from api.example.test. Check the URL, the authentication or the format.',
    );
  });

  it('reads the status out of the message when the details were lost on the way', () => {
    expect(describeImportError(failed(403, false), URL)).toContain('403 Forbidden');
    expect(describeImportError(new Error('HTTP 500 from upstream'), URL)).toContain('500 Internal Server Error');
  });

  it('names a DNS, refused or timed-out host', () => {
    expect(describeImportError(new Error('getaddrinfo ENOTFOUND api.example.test'), URL)).toBe(
      'api.example.test could not be found. Check the address, or whether a VPN is needed.',
    );
    expect(describeImportError(new Error('connect ECONNREFUSED 127.0.0.1:443'), URL)).toContain(
      'Nothing answered at api.example.test',
    );
    expect(describeImportError(new Error('The request timed out.'), URL)).toContain('did not answer in time');
  });

  it('keeps a message main already phrased, and adds the general hint to any other', () => {
    const phrased = 'The server answered 404 Not Found for http://x.test/?wsdl. Check the URL.';
    expect(describeImportError(new Error(phrased), 'http://x.test/?wsdl')).toBe(phrased);
    expect(describeImportError(new Error('Not a Postman collection'), '')).toBe(
      'Not a Postman collection. Check the URL, the authentication or the format.',
    );
    expect(describeImportError(undefined, '')).toBe('Import failed. Check the URL, the authentication or the format.');
  });
});
