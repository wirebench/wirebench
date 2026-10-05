import { describe, expect, it } from 'vitest';
import {
  authConfigWireSchema,
  authSummaryWireSchema,
  definitionAuthWireSchema,
  importAuthSchema,
  projectChangeSchema,
} from '../src/shared/wire-types.js';

describe('Kerberos on the wire', () => {
  it('is an auth config with spn and principal, at every SOAP site', () => {
    const auth = {
      type: 'kerberos',
      spn: 'HTTP/x',
      principal: 'a@R',
      username: 'u',
      domain: 'D',
      passwordRef: 'r',
    } as const;
    expect(authConfigWireSchema.parse(auth)).toEqual(auth);
    for (const change of [
      { kind: 'update-request-auth', requestId: 'r1', auth },
      { kind: 'update-interface-auth', interfaceId: 'i1', auth },
      { kind: 'update-endpoint-auth', interfaceId: 'i1', endpointId: 'e1', auth },
    ]) {
      expect(projectChangeSchema.safeParse(change).success).toBe(true);
    }
  });

  it('is a definition auth, and refuses a plaintext password there', () => {
    expect(definitionAuthWireSchema.safeParse({ type: 'kerberos', spn: 'HTTP/x' }).success).toBe(true);
    expect(definitionAuthWireSchema.safeParse({ type: 'kerberos', password: 'p' }).success).toBe(false);
  });

  it('is a WSDL import auth with only an optional SPN', () => {
    expect(importAuthSchema.safeParse({ type: 'kerberos' }).success).toBe(true);
    expect(importAuthSchema.safeParse({ type: 'kerberos', spn: 'HTTP/x' }).success).toBe(true);
    expect(importAuthSchema.safeParse({ username: 'u', passwordRef: 'r' }).success).toBe(true);
    expect(importAuthSchema.safeParse({ type: 'kerberos', password: 'p' }).success).toBe(false);
  });

  it('carries the SPN in the auth summary', () => {
    expect(
      authSummaryWireSchema.parse({ scheme: 'kerberos', challenged: true, attempts: 2, spn: 'HTTP/x' }),
    ).toMatchObject({ spn: 'HTTP/x' });
  });
});
