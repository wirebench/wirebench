import { describe, expect, it } from 'vitest';
import { challengedRequest } from '../../../../src/http/auth/challenged-hop.js';
import type { HttpExchange, HttpRequest } from '../../../../src/http/types.js';

const request: HttpRequest = {
  url: 'http://soap.example/svc',
  method: 'POST',
  headers: { 'content-type': 'text/xml' },
  body: new TextEncoder().encode('<Envelope/>'),
  timeoutMs: 1000,
  followRedirects: false,
};

/** The leg-1 exchange that ended at `hop`, after the given redirects. */
function challengeAt(hop: string, redirects: HttpExchange['redirects'], method = 'POST'): HttpExchange {
  return { request: { url: hop, method, headers: {} }, redirects } as unknown as HttpExchange;
}

describe('challengedRequest after an https upgrade (#71)', () => {
  it('sends the later legs to the upgraded hop, method and body kept', () => {
    const challenge = challengeAt('https://soap.example/svc', [
      { url: 'http://soap.example/svc', status: 301, upgrade: true },
    ]);
    const next = challengedRequest(request, challenge, 'ntlm');
    expect(next).toMatchObject({ url: 'https://soap.example/svc', method: 'POST', body: request.body });
  });

  it('accepts a same-origin hop after the upgrade', () => {
    const challenge = challengeAt('https://soap.example/v2/svc', [
      { url: 'http://soap.example/svc', status: 301, upgrade: true },
      { url: 'https://soap.example/svc', status: 307 },
    ]);
    expect(challengedRequest(request, challenge, 'kerberos').url).toBe('https://soap.example/v2/svc');
  });

  it('still refuses any other origin', () => {
    const challenge = challengeAt('https://other.example/svc', [{ url: 'http://soap.example/svc', status: 307 }]);
    expect(() => challengedRequest(request, challenge, 'ntlm')).toThrow(
      expect.objectContaining({ code: 'ntlm-cross-origin' }),
    );
  });

  it('refuses an https hop on the same host the request was not upgraded to', () => {
    const challenge = challengeAt('https://soap.example/svc2', [{ url: 'http://soap.example/svc', status: 307 }]);
    expect(() => challengedRequest(request, challenge, 'ntlm')).toThrow(
      expect.objectContaining({ code: 'ntlm-cross-origin' }),
    );
  });
});
