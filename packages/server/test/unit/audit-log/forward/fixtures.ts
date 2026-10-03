import type { AuditEvent } from '@wirebench/engine';

/** A fixed audit event, as the API returns it. */
export function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '01JAUDITEVENT0000000000001',
    at: '2026-10-03T12:00:00.000Z',
    actor: { kind: 'user', userId: 'u1', email: 'ada@example.com' },
    action: 'team.created',
    target: { kind: 'team', id: 't1' },
    workspaceId: null,
    teamId: 't1',
    ip: '127.0.0.1',
    userAgent: null,
    details: { name: 'Core' },
    ...overrides,
  };
}
