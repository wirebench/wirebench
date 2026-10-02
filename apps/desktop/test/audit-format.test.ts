import { AUDIT_ACTION_GROUPS } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import {
  ACTION_GROUP_LABELS,
  ACTION_GROUPS,
  actionLabel,
  actorLabel,
  rangeOf,
  targetLabel,
} from '../src/renderer/state/audit-format.js';

describe('audit labels and ranges (audit-log spec §3.6)', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('range presets are half-open from the past to now, and "all" is unbounded', () => {
    expect(rangeOf('24h', now)).toEqual({ from: '2026-10-01T12:00:00.000Z', to: undefined });
    expect(rangeOf('7d', now).from).toBe('2026-09-25T12:00:00.000Z');
    expect(rangeOf('30d', now).from).toBe('2026-09-02T12:00:00.000Z');
    expect(rangeOf('all', now)).toEqual({ from: undefined, to: undefined });
  });

  it('the renderer copy of the groups matches the engine', () => {
    expect([...ACTION_GROUPS]).toEqual([...AUDIT_ACTION_GROUPS]);
  });

  it('labels are words, not identifiers', () => {
    expect(actionLabel('workspace.default_role_changed')).toBe('Default role changed');
    expect(actionLabel('ci_token.revoked')).toBe('Revoked');
    expect(ACTION_GROUP_LABELS['ci_token']).toBe('CI tokens');
    expect(actorLabel({ kind: 'user', email: 'a@example.com' })).toBe('a@example.com');
    expect(actorLabel({ kind: 'system' })).toBe('Server console');
    expect(actorLabel({ kind: 'anonymous' })).toBe('Not signed in');
    expect(actorLabel({ kind: 'ci-token', tokenId: 'T' })).toBe('CI token');
    expect(targetLabel({ target: { kind: 'invitation', id: 'I1' }, details: { emailLower: 'x@example.com' } })).toBe(
      'Invitation for x@example.com',
    );
    expect(targetLabel({ target: { kind: 'team', id: 'T1' }, details: { name: 'Billing' } })).toBe('Team Billing');
    expect(targetLabel({ target: { kind: 'server', id: null }, details: {} })).toBe('This server');
  });
});
