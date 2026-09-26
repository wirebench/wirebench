/**
 * What the definition Authentication section sends: only a complete credential, only its
 * references, and a stored one offered again only on the same origin.
 */
import { describe, expect, it } from 'vitest';
import { sameOrigin, toDefinitionAuthWire } from '../../src/renderer/components/definition-auth.js';

describe('toDefinitionAuthWire', () => {
  it('keeps only the fields a definition fetch uses', () => {
    expect(toDefinitionAuthWire({ type: 'basic', username: 'ada', passwordRef: 'ref-p', preemptive: false })).toEqual({
      type: 'basic',
      username: 'ada',
      passwordRef: 'ref-p',
    });
    expect(toDefinitionAuthWire({ type: 'bearer', tokenRef: 'ref-t', scheme: ' Token ' })).toEqual({
      type: 'bearer',
      tokenRef: 'ref-t',
      scheme: 'Token',
    });
    expect(toDefinitionAuthWire({ type: 'api-key', name: ' api_key ', in: 'query', valueRef: 'ref-v' })).toEqual({
      type: 'api-key',
      name: 'api_key',
      in: 'query',
      valueRef: 'ref-v',
    });
  });

  it('sends nothing for None, or for a credential whose secret or name is missing', () => {
    expect(toDefinitionAuthWire(undefined)).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'none' })).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'basic', username: 'ada' })).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'bearer', scheme: 'Bearer' })).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'api-key', name: '', in: 'header', valueRef: 'ref-v' })).toBeUndefined();
  });
});

describe('sameOrigin', () => {
  it('matches scheme, host and port, and nothing that is not a URL', () => {
    expect(sameOrigin('https://gw.test/a/openapi.yaml', 'https://gw.test/b/v2.yaml')).toBe(true);
    expect(sameOrigin('https://gw.test/openapi.yaml', 'http://gw.test/openapi.yaml')).toBe(false);
    expect(sameOrigin('https://gw.test/openapi.yaml', 'https://gw.test:8443/openapi.yaml')).toBe(false);
    expect(sameOrigin('https://gw.test/openapi.yaml', 'https://other.test/openapi.yaml')).toBe(false);
    expect(sameOrigin('/tmp/openapi.yaml', 'https://gw.test/openapi.yaml')).toBe(false);
  });
});
