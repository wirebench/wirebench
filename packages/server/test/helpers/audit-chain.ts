/** Shared by the chain's unit and integration tests. */
import type { CanonicalRow } from '../../src/audit-log/chain/canonical.js';

/**
 * The texts Postgres renders for the row `test/integration/audit-log/chain-repo.test.ts` inserts: nulls,
 * multi-byte UTF-8, normalised `details` text, a microsecond `at` and an IPv6 address.
 */
export const FIXED_ROW: CanonicalRow = {
  id: '01J9ZK3V8Q0000000000000001',
  at: '2026-10-03T09:15:42.123456Z',
  actorKind: 'user',
  actorUserId: 'U1',
  actorEmail: 'zoë@例え.jp',
  actorTokenId: null,
  actorWorkspaceId: null,
  action: 'workspace.pushed',
  targetKind: 'workspace',
  targetId: 'W1',
  workspaceId: 'W1',
  teamId: null,
  ip: '2001:db8::7',
  userAgent: null,
  details: '{"a": 1, "b": "ü", "z": [true, null]}',
};
