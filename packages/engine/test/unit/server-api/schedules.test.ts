import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  SCHEDULE_LIMITS,
  alertTargetInputSchema,
  scheduleCreateSchema,
  scheduleRunDetailSchema,
  scheduleRunsQuerySchema,
  scheduleSecretsSchema,
  scheduleUpdateSchema,
} from '../../../src/index.js';

const target = { project: 'billing' };

describe('scheduled-runs wire shapes (scheduled-runs §3.7)', () => {
  it('scheduled-runs is a feature a license can grant', () => {
    expect(FEATURES).toContain('scheduled-runs');
  });

  it('a create fills the defaults: UTC, enabled, the default options and no alerts', () => {
    const created = scheduleCreateSchema.parse({ name: ' Smoke ', schedule: '*/5 * * * *', target });
    expect(created).toEqual({
      name: 'Smoke',
      schedule: '*/5 * * * *',
      timeZone: 'UTC',
      target,
      options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
      alerts: { targets: [], muteAfter: 3 },
      enabled: true,
    });
  });

  it('a target is the run arguments inside a workspace project, nothing else', () => {
    const full = {
      project: 'billing',
      environment: 'prod',
      select: ['Orders'],
      sequences: ['Checkout'],
      data: { path: 'data/users.csv', overrun: 'wrap', iterations: 3 },
    };
    expect(scheduleCreateSchema.parse({ name: 'x', schedule: '@hourly', target: full }).target).toEqual(full);
    // A slug keeps case and spaces, so a project is named as the workspace names it.
    expect(
      scheduleCreateSchema.parse({ name: 'x', schedule: '@hourly', target: { project: 'Country Info' } }).target,
    ).toEqual({ project: 'Country Info' });
    expect(scheduleCreateSchema.safeParse({ name: 'x', schedule: '@hourly', target: { project: ' ' } }).success).toBe(
      false,
    );
    expect(
      scheduleCreateSchema.safeParse({ name: 'x', schedule: '@hourly', target: { ...target, path: '/etc' } }).success,
    ).toBe(false);
  });

  it('bounds the options and the mute count', () => {
    const at = (options: unknown, alerts: unknown = undefined): boolean =>
      scheduleCreateSchema.safeParse({ name: 'x', schedule: '@daily', target, options, alerts }).success;
    expect(at({ timeoutMinutes: SCHEDULE_LIMITS.maxTimeoutMinutes })).toBe(true);
    expect(at({ timeoutMinutes: 0 })).toBe(false);
    expect(at({ timeoutMinutes: 121 })).toBe(false);
    expect(at(undefined, { muteAfter: 0 })).toBe(true);
    expect(at(undefined, { muteAfter: 101 })).toBe(false);
  });

  it('alert targets: https only, no credentials, at most twenty addresses', () => {
    expect(alertTargetInputSchema.safeParse({ kind: 'slack', url: 'https://hooks.example.test/a' }).success).toBe(true);
    expect(alertTargetInputSchema.safeParse({ kind: 'slack', url: 'http://hooks.example.test/a' }).success).toBe(false);
    expect(alertTargetInputSchema.safeParse({ kind: 'teams', url: 'https://u:p@example.test/a' }).success).toBe(false);
    expect(alertTargetInputSchema.safeParse({ kind: 'webhook', url: 'https://x.test', secret: 'short' }).success).toBe(
      false,
    );
    const many = Array.from({ length: 21 }, (_, i) => `ops${i}@example.test`);
    expect(alertTargetInputSchema.safeParse({ kind: 'email', to: many }).success).toBe(false);
    expect(alertTargetInputSchema.safeParse({ kind: 'email', to: ['not an address'] }).success).toBe(false);
    expect(alertTargetInputSchema.safeParse({ kind: 'email', to: many.slice(0, 20) }).success).toBe(true);
  });

  it('an update changes at least one field and never the secrets', () => {
    expect(scheduleUpdateSchema.safeParse({}).success).toBe(false);
    expect(scheduleUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(scheduleUpdateSchema.safeParse({ secrets: { A: 'b' } }).success).toBe(false);
  });

  it('secrets are named as WIREBENCH_SECRET_<NAME> without the prefix; null removes one', () => {
    expect(scheduleSecretsSchema.parse({ API_KEY: 'value', OLD: null })).toEqual({ API_KEY: 'value', OLD: null });
    expect(scheduleSecretsSchema.safeParse({ 'api-key': 'value' }).success).toBe(false);
    expect(scheduleSecretsSchema.safeParse({ EMPTY: '' }).success).toBe(false);
  });

  it('a run page query pages within the limits', () => {
    expect(scheduleRunsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(scheduleRunsQuerySchema.parse({ limit: '200', status: 'failed' })).toEqual({ limit: 200, status: 'failed' });
    expect(scheduleRunsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('a run detail keeps each result as the json report has it, and its alert deliveries', () => {
    const result = {
      path: 'A/b',
      group: 'A',
      name: 'b',
      protocol: 'rest',
      outcome: 'failed',
      status: 500,
      assertions: [],
    };
    const detail = scheduleRunDetailSchema.parse({
      id: '01K000000000000000000000R1',
      scheduleId: '01K000000000000000000000S1',
      trigger: 'schedule',
      status: 'failed',
      reason: null,
      commit: null,
      environment: 'prod',
      queuedAt: '2026-10-13T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 12 },
      results: [result],
      alerts: [{ kind: 'failure', target: 0, state: 'dead', attempts: 8, lastError: 'answered 410' }],
    });
    expect(detail.results[0]).toEqual(result);
    expect(detail.alerts[0]?.state).toBe('dead');
  });
});
