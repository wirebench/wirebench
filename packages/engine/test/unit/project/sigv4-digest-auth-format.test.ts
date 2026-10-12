import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION } from '../../../src/project/model.js';
import { authConfigSchema, definitionAuthSchema, soapOwnerAuthSchema } from '../../../src/project/schema-parts.js';

const SIGV4 = {
  type: 'aws-sigv4',
  region: 'eu-west-1',
  service: 'execute-api',
  accessKeyIdRef: 'sec_a',
  accessKeyIdEnv: 'AWS_KEY',
  secretAccessKeyRef: 'sec_b',
  sessionTokenRef: 'sec_c',
  placement: 'query',
  expiresSeconds: 600,
};
const DIGEST = { type: 'digest', username: 'admin', passwordRef: 'sec_d', passwordEnv: 'APPLIANCE' };

describe('aws-sigv4 and digest auth in the project format', () => {
  it('need format 10, so an older build refuses the project', () => {
    expect(FORMAT_VERSION).toBe(10);
  });

  it('are accepted on REST and SOAP owners', () => {
    for (const schema of [authConfigSchema, soapOwnerAuthSchema]) {
      expect(schema.parse(SIGV4)).toEqual(SIGV4);
      expect(schema.parse(DIGEST)).toEqual(DIGEST);
      expect(schema.safeParse({ type: 'aws-sigv4', region: '', service: '' }).success).toBe(true);
      expect(schema.safeParse({ type: 'digest' }).success).toBe(true);
    }
  });

  it('are not definition-fetch credentials', () => {
    expect(definitionAuthSchema.safeParse(SIGV4).success).toBe(false);
    expect(definitionAuthSchema.safeParse(DIGEST).success).toBe(false);
  });

  it('refuse a plaintext key, secret, token or password', () => {
    for (const key of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
      expect(authConfigSchema.safeParse({ ...SIGV4, [key]: 'AKIA…' }).success).toBe(false);
    }
    expect(authConfigSchema.safeParse({ ...DIGEST, password: 'hunter2' }).success).toBe(false);
    expect(soapOwnerAuthSchema.safeParse({ ...DIGEST, password: 'hunter2' }).success).toBe(false);
  });

  it('refuse an expiry AWS would not accept', () => {
    expect(authConfigSchema.safeParse({ ...SIGV4, expiresSeconds: 0 }).success).toBe(false);
    expect(authConfigSchema.safeParse({ ...SIGV4, expiresSeconds: 604_801 }).success).toBe(false);
    expect(authConfigSchema.safeParse({ ...SIGV4, placement: 'body' }).success).toBe(false);
  });
});
