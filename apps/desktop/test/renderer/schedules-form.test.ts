/**
 * The schedules view's pure parts (#517): the dialog's form, the secrets dialog's request, how a
 * schedule reads, which dot it shows, and the Explorer node.
 */
import { describe, expect, it } from 'vitest';
import type { ScheduleChoiceWire, ScheduleWire } from '../../src/shared/schedules-wire.js';
import {
  emptyAlertRow,
  formOf,
  problemOf,
  requestOf,
  withChoices,
} from '../../src/renderer/features/schedules/schedule-form.js';
import { countsText, describeCron, describeTarget } from '../../src/renderer/features/schedules/schedule-format.js';
import { secretsProblemOf, secretsRequestOf } from '../../src/renderer/features/schedules/secrets-dialog.js';
import { scheduleStateOf, schedulesShown } from '../../src/renderer/state/schedules.js';
import { schedulesNode } from '../../src/renderer/features/explorer/tree-nodes.js';

const SCHEDULE: ScheduleWire = {
  id: 'S1',
  workspaceId: 'W1',
  name: 'Smoke',
  cron: '*/5 * * * *',
  timeZone: 'Europe/Vienna',
  target: { project: 'P1', environment: 'E1', select: ['Shop/Users', 'Other/thing'] },
  options: { timeoutMinutes: 20, allowProtected: false, insecureTls: false, bail: true },
  alerts: { targets: [{ kind: 'webhook', host: 'ops.example.com', hint: 'ab12', signed: true }], muteAfter: 3 },
  secrets: [],
  enabled: true,
  nextRunAt: null,
  alertState: 'ok',
  failureStreak: 0,
  createdBy: null,
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  lastRun: null,
};

const CHOICES: ScheduleChoiceWire[] = [
  { id: 'A1', kind: 'api', label: 'Shop', depth: 0, selectors: ['Shop'] },
  { id: 'F1', kind: 'folder', label: 'Users', depth: 1, selectors: ['Shop/Users'] },
];

describe('the schedule form', () => {
  it('opens with the defaults for a new schedule', () => {
    const form = formOf(undefined, { timeZone: 'UTC', projectId: 'P1' });
    expect(form).toMatchObject({ name: '', timeZone: 'UTC', projectId: 'P1', mode: 'all', timeoutMinutes: '15' });
    expect(problemOf(form)).toBe('Give the schedule a name.');
  });

  it('opens on a Schedule… target', () => {
    const form = formOf(undefined, { timeZone: 'UTC', target: { project: 'P2', sequences: ['Flow'] } });
    expect(form).toMatchObject({ projectId: 'P2', mode: 'sequences', sequences: ['Flow'] });
  });

  it('picks the choices a schedule names and keeps the selectors none stands for', () => {
    const form = withChoices(formOf(SCHEDULE, { timeZone: 'UTC' }), CHOICES);
    expect(form.picked).toEqual(['F1']);
    expect(form.extraSelectors).toEqual(['Other/thing']);
  });

  it('leaves untouched alerts out of the request', () => {
    const form = withChoices(formOf(SCHEDULE, { timeZone: 'UTC' }), CHOICES);
    expect(problemOf(form)).toBeUndefined();
    const request = requestOf(form, CHOICES);
    expect(request).not.toHaveProperty('alerts');
    expect(request.target).toEqual({ project: 'P1', environment: 'E1', select: ['Shop/Users', 'Other/thing'] });
    expect(request.options).toEqual({ timeoutMinutes: 20, bail: true, allowProtected: false, insecureTls: false });
  });

  it('asks for a kept URL again once the alerts are changed', () => {
    const form = { ...formOf(SCHEDULE, { timeZone: 'UTC' }), alertsTouched: true };
    expect(problemOf(form)).toBe('Alert 1: enter the URL again (only ops.example.com …ab12 can be read back).');
    const fixed = {
      ...form,
      alerts: [
        { ...form.alerts[0]!, url: 'https://ops.example.com/hook' },
        { ...emptyAlertRow('email'), to: 'a@b.c' },
      ],
    };
    expect(problemOf(fixed)).toBeUndefined();
    expect(requestOf(fixed, CHOICES).alerts).toEqual({
      targets: [
        { kind: 'webhook', url: 'https://ops.example.com/hook' },
        { kind: 'email', to: ['a@b.c'] },
      ],
      muteAfter: 3,
    });
  });

  it('refuses a plain-http alert URL and a bad timeout', () => {
    const base = { ...formOf(SCHEDULE, { timeZone: 'UTC' }), alertsTouched: true };
    expect(problemOf({ ...base, alerts: [{ ...emptyAlertRow('slack'), url: 'http://x.test' }] })).toMatch(/https:\/\//);
    expect(problemOf({ ...base, timeoutMinutes: '0' })).toBe('The timeout is 1 to 120 minutes.');
  });
});

describe('the secrets dialog', () => {
  it('sends new values and clears removed names', () => {
    expect(
      secretsRequestOf(
        [
          { name: 'API_KEY', value: 'v' },
          { name: 'KEPT', value: '' },
        ],
        ['OLD'],
      ),
    ).toEqual({ OLD: null, API_KEY: 'v' });
  });

  it('refuses a bad name, an empty value and a duplicate', () => {
    expect(secretsProblemOf([{ name: 'api-key', value: 'v' }])).toMatch(/not a secret name/);
    expect(secretsProblemOf([{ name: 'A', value: '' }])).toBe('Enter a value for A.');
    expect(
      secretsProblemOf([
        { name: 'A', value: '1' },
        { name: 'A', value: '2' },
      ]),
    ).toBe('A is listed twice.');
    expect(secretsProblemOf([{ name: '', value: '' }])).toBeUndefined();
  });
});

describe('how a schedule reads', () => {
  it('words the common cron shapes and leaves the rest as written', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeCron('0 * * * *')).toBe('Hourly');
    expect(describeCron('30 7 * * *')).toBe('Daily at 07:30');
    expect(describeCron('0 9 * * 1')).toBe('Mondays at 09:00');
    expect(describeCron('0 9 1 * *')).toBe('0 9 1 * *');
  });

  it('names the target with the open workspace’s names', () => {
    expect(describeTarget(SCHEDULE.target, { project: 'Shop', environment: 'Dev' })).toBe(
      'Shop: Shop/Users, Other/thing · Dev',
    );
    expect(describeTarget({ project: 'P1', sequences: ['A', 'B'] }, {})).toBe('P1: 2 sequences');
  });

  it('counts a run, or gives its reason', () => {
    expect(
      countsText({ summary: { total: 3, passed: 2, failed: 1, errored: 0, skipped: 0, durationMs: 1 }, reason: null }),
    ).toBe('2 passed, 1 failed');
    expect(countsText({ summary: null, reason: 'Timed out' })).toBe('Timed out');
  });

  it('shows paused before failing, and never-run apart from passing', () => {
    expect(scheduleStateOf({ ...SCHEDULE, enabled: false, alertState: 'failing' })).toBe('paused');
    expect(scheduleStateOf({ ...SCHEDULE, alertState: 'failing' })).toBe('failing');
    expect(scheduleStateOf(SCHEDULE)).toBe('never');
  });

  it('hides Schedules when the server lacks them or the licence lapsed', () => {
    expect(schedulesShown({ available: true, error: undefined })).toBe(true);
    expect(schedulesShown({ available: false, error: undefined })).toBe(false);
    expect(
      schedulesShown({ available: true, error: { code: 'licensing-feature-required', message: 'Enterprise' } }),
    ).toBe(false);
  });
});

describe('the Schedules node', () => {
  it('counts failing schedules on the root and the streak on each failing one', () => {
    const node = schedulesNode({
      canEdit: false,
      schedules: [
        { id: 'S1', name: 'Smoke', state: 'failing', failureStreak: 4, when: 'Every 5 minutes' },
        { id: 'S2', name: 'Nightly', state: 'ok', failureStreak: 0, when: 'Daily at 02:00' },
      ],
    });
    expect(node).toMatchObject({ id: 'schedules', kind: 'schedules', failing: 1, canEdit: false });
    expect(node.children?.[0]).toMatchObject({
      id: 'schedule:S1',
      scheduleId: 'S1',
      scheduleState: 'failing',
      failing: 4,
    });
    expect(node.children?.[1]).not.toHaveProperty('failing');
  });
});
