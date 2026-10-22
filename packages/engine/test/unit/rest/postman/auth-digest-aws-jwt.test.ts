import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection } from '#protocol-rest/rest/postman/map';
import { parsePostmanCollection } from '#protocol-rest/rest/postman/parse';

const info = { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };

function importAuth(auth: Record<string, unknown>) {
  return apiFromPostmanCollection(
    parsePostmanCollection({ info, auth, item: [{ name: 'R', request: { method: 'GET', url: '/x' } }] }),
  );
}

const jwtWarning = 'JWT: the secret or key is not copied; set the secret (HS*) or key (RS*/ES*/PS*) before sending';
const credentialWarning = 'Credentials are not copied from the collection; re-enter them for 1 auth configuration';

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

  it('warns about a missing AWS region and service', () => {
    const { api, summary } = importAuth({ type: 'awsv4', awsv4: attrs({ accessKey: 'K' }) });
    expect(api.auth).toEqual({ type: 'aws-sigv4', region: '', service: '' });
    expect(summary.warnings).toContain('AWS Signature: region is not set');
    expect(summary.warnings).toContain('AWS Signature: service is not set');
  });

  it('does not warn about a region and service that are set', () => {
    const { summary } = importAuth({ type: 'awsv4', awsv4: attrs({ region: 'eu-west-1', service: 's3' }) });
    expect(summary.warnings?.some((w) => w.startsWith('AWS Signature')) ?? false).toBe(false);
  });

  it('gives a JWT with a secret one line, not the credential count too', () => {
    const { summary } = importAuth({ type: 'jwt', jwt: attrs({ algorithm: 'HS256', secret: 'topsecret' }) });
    expect(summary.warnings).toContain(jwtWarning);
    expect(summary.warnings).not.toContain(credentialWarning);
  });

  it('warns that a JWT needs its secret even when the file had none', () => {
    const { api, summary } = importAuth({ type: 'jwt', jwt: attrs({ algorithm: 'HS256' }) });
    expect(api.auth).toMatchObject({ type: 'jwt', algorithm: 'HS256' });
    expect(summary.warnings).toContain(jwtWarning);
  });
});
