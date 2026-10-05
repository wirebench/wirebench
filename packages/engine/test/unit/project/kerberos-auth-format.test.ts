import { describe, expect, it } from 'vitest';
import {
  authConfigSchema,
  definitionAuthSchema,
  kerberosAuthSchema,
  soapOwnerAuthSchema,
} from '../../../src/project/schema-parts.js';
import { FORMAT_VERSION } from '../../../src/project/model.js';
import { effectiveAuth } from '../../../src/project/endpoints.js';

const KERBEROS = {
  type: 'kerberos',
  spn: 'HTTP/svc.corp',
  principal: 'a@CORP',
  username: 'u',
  domain: 'D',
  passwordRef: 'sec_1',
};

describe('kerberos auth in the project format', () => {
  it('is accepted at every site', () => {
    for (const schema of [kerberosAuthSchema, authConfigSchema, soapOwnerAuthSchema, definitionAuthSchema]) {
      expect(schema.safeParse(KERBEROS).success).toBe(true);
      expect(schema.safeParse({ type: 'kerberos' }).success).toBe(true);
    }
  });

  it('refuses a plaintext password', () => {
    for (const schema of [authConfigSchema, soapOwnerAuthSchema, definitionAuthSchema]) {
      expect(schema.safeParse({ type: 'kerberos', password: 'hunter2' }).success).toBe(false);
    }
  });

  it('is format 8', () => {
    expect(FORMAT_VERSION).toBe(8);
  });

  it('is a whole value under effectiveAuth: nothing merges into it', () => {
    const endpoint = { type: 'kerberos' } as const;
    const request = { type: 'basic', username: 'u', passwordRef: 'r' } as const;
    expect(effectiveAuth(request, endpoint, 'complement')).toEqual(request);
    expect(effectiveAuth(undefined, endpoint, 'complement', { type: 'basic', username: 'x' })).toEqual(endpoint);
  });
});
