import { describe, expect, it } from 'vitest';
import {
  DEVICE_TOKEN_PATTERN,
  invitationAcceptRequestSchema,
  localSignInRequestSchema,
  meResponseSchema,
  metaResponseSchema,
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  SECRET_PATTERN,
  signInResponseSchema,
} from '../../../src/index.js';

const SECRET = 'A'.repeat(43);
const USER = { id: '01J8Z0000000000000000000AB', email: 'alice@example.com', displayName: 'Alice', serverAdmin: true };

describe('server-api identity schemas', () => {
  it('parse the documented examples', () => {
    expect(
      localSignInRequestSchema.parse({ email: 'a@b.co', password: 'x'.repeat(12), device: { name: 'Mac' } }),
    ).toMatchObject({ device: { name: 'Mac' } });
    expect(signInResponseSchema.parse({ token: `wbs_${SECRET}`, user: USER }).user.serverAdmin).toBe(true);
    expect(
      oidcStartRequestSchema.parse({ device: { name: 'Mac' }, codeChallenge: SECRET, loopbackPort: 49152 })
        .loopbackPort,
    ).toBe(49152);
    expect(oidcCompleteRequestSchema.parse({ flowId: 'f', grant: SECRET, codeVerifier: 'v'.repeat(43) }).grant).toBe(
      SECRET,
    );
    expect(
      meResponseSchema.parse({ user: USER, methods: { local: true, oidc: [{ issuer: 'https://idp.test' }] } }).methods
        .oidc,
    ).toHaveLength(1);
    expect(
      invitationAcceptRequestSchema.parse({
        secret: SECRET,
        displayName: 'Alice',
        password: 'p'.repeat(12),
        device: { name: 'Mac' },
      }).displayName,
    ).toBe('Alice');
    expect(
      metaResponseSchema.parse({
        name: 'wirebench-server',
        version: '1',
        apiVersion: 1,
        publicUrl: 'https://x.test',
        auth: { local: true, oidc: false },
        capabilities: [],
      }).apiVersion,
    ).toBe(1);
  });

  it('refuse the shapes the server must never accept', () => {
    expect(signInResponseSchema.safeParse({ token: 'not-a-token', user: USER }).success).toBe(false);
    expect(
      oidcStartRequestSchema.safeParse({ device: { name: 'Mac' }, codeChallenge: 'short', loopbackPort: 1 }).success,
    ).toBe(false);
    expect(
      oidcStartRequestSchema.safeParse({ device: { name: 'Mac' }, codeChallenge: SECRET, loopbackPort: 70000 }).success,
    ).toBe(false);
    expect(localSignInRequestSchema.safeParse({ email: 'a@b.co', password: '', device: { name: 'Mac' } }).success).toBe(
      false,
    );
    expect(
      localSignInRequestSchema.safeParse({
        email: 'a@b.co',
        password: 'x'.repeat(12),
        device: { name: 'n'.repeat(81) },
      }).success,
    ).toBe(false);
    expect(SECRET_PATTERN.test('A'.repeat(42))).toBe(false);
    expect(DEVICE_TOKEN_PATTERN.test(`wbs_${SECRET}`)).toBe(true);
  });
});
