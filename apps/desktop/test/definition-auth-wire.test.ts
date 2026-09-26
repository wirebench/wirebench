/**
 * A definition's fetch credentials on the wire: references only, for a URL only, and never a scheme
 * a definition fetch cannot use. Every refusal here is a validation failure over IPC, so a plaintext
 * secret sent by mistake never reaches main, let alone a project file.
 */
import { describe, expect, it } from 'vitest';
import {
  apiAsyncApiServersRequestSchema,
  apiImportAsyncApiRequestSchema,
  apiImportOpenApiRequestSchema,
  apiRestPlanUpdateRequestSchema,
  definitionAuthWireSchema,
} from '../src/shared/wire-types.js';

const URL_SOURCE = { kind: 'url', url: 'https://gateway.test/openapi.yaml' } as const;
const BASIC = { type: 'basic', username: 'ada', passwordRef: 'ref-p' } as const;

/** Every channel that reads a definition for an import, with the rest of a valid request. */
const IMPORTS = [
  [
    'api.importOpenApi',
    (body: object) => apiImportOpenApiRequestSchema.safeParse({ target: { projectId: 'p1' }, ...body }),
  ],
  [
    'api.importAsyncApi',
    (body: object) => apiImportAsyncApiRequestSchema.safeParse({ target: { projectId: 'p1' }, ...body }),
  ],
  ['api.asyncApiServers', (body: object) => apiAsyncApiServersRequestSchema.safeParse(body)],
] as const;

describe('definitionAuthWireSchema', () => {
  it.each([
    ['basic', BASIC],
    ['bearer', { type: 'bearer', tokenRef: 'ref-t', scheme: 'Token' }],
    ['a header API key', { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'ref-v' }],
    ['a query API key', { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' }],
  ])('accepts %s as references', (_label, auth) => {
    expect(definitionAuthWireSchema.safeParse(auth).success).toBe(true);
  });

  it.each([
    ['a plaintext password', { ...BASIC, password: 'hunter2' }],
    ['a plaintext token', { type: 'bearer', tokenRef: 'ref-t', token: 'abc' }],
    ['a plaintext value', { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'ref-v', value: 'k' }],
    ['NTLM', { type: 'ntlm', username: 'ada', passwordRef: 'ref-p' }],
    ['OAuth2', { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t.test', clientId: 'c' }],
    ['an API key with no name', { type: 'api-key', name: '', in: 'header', valueRef: 'ref-v' }],
  ])('refuses %s', (_label, auth) => {
    expect(definitionAuthWireSchema.safeParse(auth).success).toBe(false);
  });
});

describe('credentials on an import request', () => {
  for (const [channel, parse] of IMPORTS) {
    it(`${channel} accepts them with a URL source`, () => {
      expect(parse({ source: URL_SOURCE, auth: BASIC }).success).toBe(true);
    });

    it(`${channel} refuses them with a file or pasted text`, () => {
      expect(parse({ source: { kind: 'file', path: '/tmp/openapi.yaml' }, auth: BASIC }).success).toBe(false);
      expect(parse({ source: { kind: 'text', text: 'openapi: 3.0.3' }, auth: BASIC }).success).toBe(false);
    });

    it(`${channel} still takes a request without them`, () => {
      expect(parse({ source: { kind: 'file', path: '/tmp/openapi.yaml' } }).success).toBe(true);
    });

    it(`${channel} refuses them with a malformed URL or a non-http(s) scheme`, () => {
      expect(parse({ source: { kind: 'url', url: 'not a url' }, auth: BASIC }).success).toBe(false);
      expect(parse({ source: { kind: 'url', url: 'file:///etc/passwd' }, auth: BASIC }).success).toBe(false);
    });
  }
});

describe('credentials on a REST update source', () => {
  it('keeps them on a URL source', () => {
    const parsed = apiRestPlanUpdateRequestSchema.parse({ apiId: 'a1', source: { ...URL_SOURCE, auth: BASIC } });
    expect(parsed.source).toEqual({ ...URL_SOURCE, auth: BASIC });
  });

  it('refuses a plaintext secret there too', () => {
    const source = { ...URL_SOURCE, auth: { ...BASIC, password: 'hunter2' } };
    expect(apiRestPlanUpdateRequestSchema.safeParse({ apiId: 'a1', source }).success).toBe(false);
  });
});
