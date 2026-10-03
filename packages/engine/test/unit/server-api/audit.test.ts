import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTIONS,
  AUDIT_LIMITS,
  DESKTOP_AUDIT_LIMITS,
  desktopAuditBatchSchema,
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
    expect(AUDIT_ACTIONS).toHaveLength(44);
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

  describe('desktop events', () => {
    const SENT = {
      protocol: 'rest',
      method: 'GET',
      url: 'https://api.example.com/orders',
      status: 200,
      outcome: 'ok',
      durationMs: 42,
      environment: 'staging',
      requestId: '01J9ZK3V8Q00000000000000R1',
      requestName: 'List orders',
      sentAt: '2026-10-03T09:00:00.000Z',
    };
    const RUN = {
      sequenceId: '01J9ZK3V8Q00000000000000S1',
      sequenceName: 'Checkout flow',
      outcome: 'passed',
      passed: 3,
      failed: 0,
      errored: 0,
      skipped: 1,
      durationMs: 1200,
      hosts: ['https://api.example.com'],
      environment: null,
      startedAt: '2026-10-03T09:00:00.000Z',
      sentAt: '2026-10-03T09:00:01.200Z',
    };
    const requestEvent = (details: object = SENT) => ({ action: 'desktop.request_sent', details });
    const runEvent = (details: object = RUN) => ({ action: 'desktop.run_finished', details });

    it('adds the four actions and the desktop group, and names the limits', () => {
      for (const a of [
        'workspace.desktop_recording_changed',
        'desktop.request_sent',
        'desktop.run_finished',
        'desktop.events_dropped',
      ]) {
        expect(AUDIT_ACTIONS).toContain(a);
      }
      expect(AUDIT_ACTION_GROUPS).toContain('desktop');
      expect(DESKTOP_AUDIT_LIMITS).toEqual({
        maxBatch: 100,
        maxOutbox: 5000,
        maxUrlLength: 2048,
        maxHosts: 64,
        maxDropped: 1_000_000,
      });
    });

    it('parses a request-sent and a run-finished event', () => {
      expect(desktopAuditBatchSchema.parse({ events: [requestEvent(), runEvent()] }).events).toHaveLength(2);
      expect(
        desktopAuditBatchSchema.safeParse({
          events: [
            requestEvent({
              ...SENT,
              protocol: 'grpc',
              method: null,
              status: null,
              outcome: 'failed',
              environment: null,
            }),
          ],
        }).success,
      ).toBe(true);
      expect(desktopAuditBatchSchema.safeParse({ events: [runEvent({ ...RUN, outcome: 'cancelled' })] }).success).toBe(
        true,
      );
    });

    it('refuses unknown keys, an oversized url, too many hosts, and an unknown action', () => {
      expect(desktopAuditBatchSchema.safeParse({ events: [requestEvent({ ...SENT, body: 'x' })] }).success).toBe(false);
      expect(desktopAuditBatchSchema.safeParse({ events: [runEvent({ ...RUN, extra: 1 })] }).success).toBe(false);
      const { sequenceName, ...unnamed } = RUN;
      expect(
        desktopAuditBatchSchema.safeParse({ events: [runEvent({ ...unnamed, name: sequenceName })] }).success,
      ).toBe(false);
      expect(
        desktopAuditBatchSchema.safeParse({ events: [requestEvent({ ...SENT, url: 'h'.repeat(2049) })] }).success,
      ).toBe(false);
      expect(
        desktopAuditBatchSchema.safeParse({ events: [requestEvent({ ...SENT, url: 'h'.repeat(2048) })] }).success,
      ).toBe(true);
      const hosts = (n: number) => Array.from({ length: n }, (_, i) => `https://h${i}.example.com`);
      expect(desktopAuditBatchSchema.safeParse({ events: [runEvent({ ...RUN, hosts: hosts(65) })] }).success).toBe(
        false,
      );
      expect(desktopAuditBatchSchema.safeParse({ events: [runEvent({ ...RUN, hosts: hosts(64) })] }).success).toBe(
        true,
      );
      expect(desktopAuditBatchSchema.safeParse({ events: [{ action: 'auth.signed_in', details: {} }] }).success).toBe(
        false,
      );
      expect(desktopAuditBatchSchema.safeParse({ events: [requestEvent({ ...SENT, sentAt: 'now' })] }).success).toBe(
        false,
      );
    });

    it('bounds the batch and needs events or a dropped count', () => {
      const many = (n: number) => Array.from({ length: n }, () => requestEvent());
      expect(desktopAuditBatchSchema.safeParse({ events: many(100) }).success).toBe(true);
      expect(desktopAuditBatchSchema.safeParse({ events: many(101) }).success).toBe(false);
      expect(desktopAuditBatchSchema.safeParse({ events: [] }).success).toBe(false);
      expect(desktopAuditBatchSchema.parse({ events: [], dropped: 3 })).toEqual({ events: [], dropped: 3 });
      expect(desktopAuditBatchSchema.safeParse({ events: [], dropped: 0 }).success).toBe(false);
      expect(desktopAuditBatchSchema.safeParse({ events: [], dropped: 1_000_000 }).success).toBe(true);
      expect(desktopAuditBatchSchema.safeParse({ events: [], dropped: 1_000_001 }).success).toBe(false);
    });
  });
});
