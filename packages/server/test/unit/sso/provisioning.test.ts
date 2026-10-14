import { describe, expect, it } from 'vitest';
import { decideProvisionedRemoval } from '../../../src/sso/provisioning.js';

describe('decideProvisionedRemoval (saml-scim plan ruling 8)', () => {
  it.each([
    [0, 'member', 'remove'],
    [1, 'member', 'keep'],
    [2, 'member', 'keep'],
    [0, 'admin', 'keep'],
    [1, 'admin', 'keep'],
  ] as const)('%i rows left, role %s → %s', (remainingRowsForTeam, role, expected) => {
    expect(decideProvisionedRemoval({ remainingRowsForTeam, role })).toBe(expected);
  });
});
