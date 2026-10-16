import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import { parsePostmanCollection } from '../../../../src/rest/postman/parse.js';

const info = { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };

function importAuth(auth: Record<string, unknown>) {
  return apiFromPostmanCollection(
    parsePostmanCollection({ info, auth, item: [{ name: 'R', request: { method: 'GET', url: '/x' } }] }),
  );
}

const attrs = (values: Record<string, unknown>) => Object.entries(values).map(([key, value]) => ({ key, value }));

describe('Postman digest, AWS and JWT auth', () => {
  it('maps digest with its username, never its password', () => {
    const { api, summary } = importAuth({ type: 'digest', digest: attrs({ username: 'u', password: 'hunter2' }) });
    expect(api.auth).toEqual({ type: 'digest', username: 'u' });
    expect(JSON.stringify(api)).not.toContain('hunter2');
    expect(summary.warnings?.some((w) => w.includes('not supported'))).not.toBe(true);
  });

  it('maps AWS Signature v4 with its region and service, never its keys', () => {
    const { api } = importAuth({
      type: 'awsv4',
      awsv4: attrs({ region: 'eu-west-1', service: 'execute-api', accessKey: 'AKIA1', secretKey: 'shh' }),
    });
    expect(api.auth).toEqual({ type: 'aws-sigv4', region: 'eu-west-1', service: 'execute-api' });
    expect(JSON.stringify(api)).not.toContain('shh');
  });

  it('maps a JWT to a header with its claims, never its secret', () => {
    const { api } = importAuth({
      type: 'jwt',
      jwt: attrs({ algorithm: 'HS256', payload: '{"sub":"1"}', secret: 'key', addTokenTo: 'header' }),
    });
    expect(api.auth).toEqual({
      type: 'jwt',
      algorithm: 'HS256',
      claims: '{"sub":"1"}',
      issuedAt: false,
      jwtId: false,
      in: 'header',
      prefix: 'Bearer',
    });
    expect(JSON.stringify(api)).not.toContain('"key"');
  });

  it('maps a JWT to a query parameter and keeps an object payload as JSON', () => {
    const { api } = importAuth({
      type: 'jwt',
      jwt: attrs({ algorithm: 'RS256', payload: { a: 1 }, addTokenTo: 'queryParam', queryParamKey: 'tok' }),
    });
    expect(api.auth).toMatchObject({ type: 'jwt', algorithm: 'RS256', claims: '{"a":1}', in: 'query', name: 'tok' });
  });

  it('sets an unknown JWT algorithm to none and names it', () => {
    const { api, summary } = importAuth({ type: 'jwt', jwt: attrs({ algorithm: 'XX999' }) });
    expect(api.auth).toEqual({ type: 'none' });
    expect(summary.warnings).toContain('JWT algorithm "XX999" is not supported; set to "none"');
  });
});
