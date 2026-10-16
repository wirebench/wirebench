import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import { parsePostmanCollection } from '../../../../src/rest/postman/parse.js';

const info = { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };

function importAuth(auth: Record<string, unknown>) {
  return apiFromPostmanCollection(
    parsePostmanCollection({ info, auth, item: [{ name: 'R', request: { method: 'GET', url: '/x' } }] }),
  );
}

const credentialWarning = 'Credentials are not copied from the collection; re-enter them for 1 auth configuration';

describe('Postman digest, AWS SigV4 and JWT auth', () => {
  it('digest keeps the username and drops a literal password with the credential warning', () => {
    const { api, summary } = importAuth({
      type: 'digest',
      digest: [
        { key: 'username', value: 'u' },
        { key: 'password', value: 'hunter2' },
      ],
    });
    expect(api.auth).toEqual({ type: 'digest', username: 'u' });
    expect(JSON.stringify(api.auth)).not.toContain('hunter2');
    expect(summary.warnings).toContain(credentialWarning);
  });

  it('a digest password that is only references is still dropped and warned', () => {
    const { api, summary } = importAuth({
      type: 'digest',
      digest: [
        { key: 'username', value: '{{user}}' },
        { key: 'password', value: '{{pass}}' },
      ],
    });
    expect(api.auth).toEqual({ type: 'digest', username: '${user}' });
    expect(summary.warnings).toContain(credentialWarning);
  });

  it('awsv4 keeps region and service and warns for literal keys', () => {
    const { api, summary } = importAuth({
      type: 'awsv4',
      awsv4: [
        { key: 'accessKey', value: 'AKIAEXAMPLE' },
        { key: 'secretKey', value: 's3cr3t' },
        { key: 'sessionToken', value: 'tok3n' },
        { key: 'region', value: 'eu-west-1' },
        { key: 'service', value: 'execute-api' },
      ],
    });
    expect(api.auth).toEqual({ type: 'aws-sigv4', region: 'eu-west-1', service: 'execute-api' });
    const text = JSON.stringify(api.auth);
    for (const secret of ['AKIAEXAMPLE', 's3cr3t', 'tok3n']) expect(text).not.toContain(secret);
    expect(summary.warnings).toContain(credentialWarning);
  });

  it('awsv4 rewrites templates in region and service', () => {
    const { api } = importAuth({
      type: 'awsv4',
      awsv4: [
        { key: 'region', value: '{{region}}' },
        { key: 'service', value: '{{svc}}' },
      ],
    });
    expect(api.auth).toEqual({ type: 'aws-sigv4', region: '${region}', service: '${svc}' });
  });

  it('jwt keeps algorithm, claims, header prefix and placement', () => {
    const { api, summary } = importAuth({
      type: 'jwt',
      jwt: [
        { key: 'algorithm', value: 'HS256' },
        { key: 'secret', value: 'topsecret' },
        { key: 'payload', value: '{"sub":"1"}' },
        { key: 'headerPrefix', value: 'Bearer' },
        { key: 'addTokenTo', value: 'header' },
      ],
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
    expect(JSON.stringify(api.auth)).not.toContain('topsecret');
    expect(summary.warnings).toContain(credentialWarning);
  });

  it('jwt placed in the query keeps its parameter name and drops a private key', () => {
    const { api, summary } = importAuth({
      type: 'jwt',
      jwt: [
        { key: 'algorithm', value: 'RS256' },
        { key: 'privateKey', value: '-----BEGIN PRIVATE KEY-----' },
        { key: 'addTokenTo', value: 'queryParam' },
        { key: 'queryParamKey', value: 'token' },
      ],
    });
    expect(api.auth).toEqual({
      type: 'jwt',
      algorithm: 'RS256',
      claims: '{}',
      issuedAt: false,
      jwtId: false,
      in: 'query',
      name: 'token',
    });
    expect(JSON.stringify(api.auth)).not.toContain('PRIVATE KEY');
    expect(summary.warnings).toContain(credentialWarning);
  });

  it('an unknown jwt algorithm becomes none, named', () => {
    const { api, summary } = importAuth({ type: 'jwt', jwt: [{ key: 'algorithm', value: 'none' }] });
    expect(api.auth).toEqual({ type: 'none' });
    expect(summary.warnings?.some((w) => w.includes('"none"') && w.includes('JWT'))).toBe(true);
  });

  it.each(['hawk', 'oauth1', 'akamai'])('%s stays none with the type named', (type) => {
    const { api, summary } = importAuth({ type });
    expect(api.auth).toEqual({ type: 'none' });
    expect(summary.warnings).toContain(`Authentication type "${type}" is not supported; set to "none"`);
  });
});
