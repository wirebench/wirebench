import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_LIMITS,
  auditEventSchema,
  auditPageSchema,
  auditQuerySchema,
} from '../../../src/index.js';

const EVENT = {
  id: '01J9ZK3V8Q0000000000000001',
  at: '2026-10-01T12:34:56.789Z',
  actor: {
    kind: 'user',
    userId: '01J9ZK3V8Q00000000000000AA',
    email: 'a@example.com',
    tokenId: '01J9ZK3V8Q00000000000000BB',
  },
  action: 'workspace.grant_set',
  target: { kind: 'user', id: '01J9ZK3V8Q00000000000000CC' },
  workspaceId: '01J9ZK3V8Q00000000000000DD',
  teamId: '01J9ZK3V8Q00000000000000EE',
  ip: '203.0.113.7',
  userAgent: 'Wirebench/3.1.0 (darwin)',
  details: { role: 'editor' },
};

describe('audit wire shapes (audit-log spec §3.4, §5.2)', () => {
  it('lists every action the spec names, dotted <area>.<verb>, no duplicates', () => {
    for (const action of [
      'auth.signed_in',
      'workspace.pushed',
      'secret.rotated',
      'hook.signature_cleared',
      'license.removed',
      'audit.exported',
    ]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS).toHaveLength(40);
  });

  it('parses an event and refuses an unknown action or a nested details value', () => {
    expect(auditEventSchema.parse(EVENT)).toEqual(EVENT);
    expect(auditEventSchema.safeParse({ ...EVENT, action: 'workspace.exploded' }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...EVENT, details: { nested: { a: 1 } } }).success).toBe(false);
    const sparse = auditEventSchema.parse({
      ...EVENT,
      actor: { kind: 'system' },
      target: { kind: 'server', id: null },
      workspaceId: null,
      teamId: null,
      ip: null,
      userAgent: null,
    });
    expect(sparse.ip).toBeNull();
  });

  it('bounds the page and accepts an action or a group prefix', () => {
    expect(auditQuerySchema.parse({}).limit).toBeUndefined();
    expect(auditQuerySchema.safeParse({ limit: AUDIT_LIMITS.maxPageSize + 1 }).success).toBe(false);
    expect(auditQuerySchema.parse({ action: 'workspace.' }).action).toBe('workspace.');
    expect(auditQuerySchema.parse({ action: 'workspace.pushed' }).action).toBe('workspace.pushed');
    expect(auditQuerySchema.safeParse({ action: 'Workspace' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });

  it('a page is events plus an optional cursor', () => {
    expect(auditPageSchema.parse({ events: [EVENT] }).next).toBeUndefined();
    expect(auditPageSchema.parse({ events: [], next: 'abc' }).next).toBe('abc');
  });
});
