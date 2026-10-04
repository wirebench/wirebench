import { describe, expect, it } from 'vitest';
import { isCredentialName } from '../../../src/import/credentials.js';

describe('isCredentialName', () => {
  it('matches a credential word anywhere in the name, ignoring case, _ and -', () => {
    for (const name of [
      'X-Auth-Token',
      'X-CSRF-Token',
      'X-XSRF-TOKEN',
      'Ocp-Apim-Subscription-Key',
      'password',
      'client_secret',
      'session',
      'accessToken',
      'clientSecret',
      'refreshToken',
      'Proxy-Authorization',
      'x-api-key',
      'apiKey',
      'passwd',
      'X-Amz-Signature',
    ]) {
      expect(isCredentialName(name), name).toBe(true);
    }
  });

  it('keeps the exact short names the redaction lists already had', () => {
    for (const name of ['key', 'KEY', 'sig', 'Cookie', 'Set-Cookie']) expect(isCredentialName(name), name).toBe(true);
  });

  it('leaves ordinary names alone', () => {
    for (const name of ['name', 'limit', 'Accept', 'Content-Type', 'page', 'monkey', 'keyword', 'User-Agent']) {
      expect(isCredentialName(name), name).toBe(false);
    }
  });
});
