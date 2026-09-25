import { describe, expect, it } from 'vitest';
import { decideLink } from '../../../src/identity/linking.js';

describe('decideLink (§3.3)', () => {
  const user = { id: 'u1', disabled: false };
  const invitation = { id: 'i1', serverAdmin: true };
  it.each([
    [
      '1: a known (iss, sub) → that user',
      { identity: { userId: 'u9', disabled: false }, emailVerified: false },
      { kind: 'existing', userId: 'u9' },
    ],
    [
      '1: a known identity of a disabled user → disabled',
      { identity: { userId: 'u9', disabled: true }, emailVerified: true, user },
      { kind: 'refuse', code: 'identity-user-disabled' },
    ],
    [
      '2: unverified email → unverified, even with a user or an invitation',
      { emailVerified: false, user, invitation },
      { kind: 'refuse', code: 'identity-email-unverified' },
    ],
    ['3: a user with that email → link', { emailVerified: true, user, invitation }, { kind: 'link', userId: 'u1' }],
    [
      '3: that user disabled → disabled',
      { emailVerified: true, user: { id: 'u1', disabled: true } },
      { kind: 'refuse', code: 'identity-user-disabled' },
    ],
    [
      '4: an open invitation → create with its admin flag',
      { emailVerified: true, invitation },
      { kind: 'create', invitationId: 'i1', serverAdmin: true },
    ],
    ['5: nothing → not invited', { emailVerified: true }, { kind: 'refuse', code: 'identity-not-invited' }],
  ] as const)('%s', (_name, facts, expected) => {
    expect(decideLink(facts)).toEqual(expected);
  });
});
