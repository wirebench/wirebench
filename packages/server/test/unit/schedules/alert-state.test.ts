import type { ScheduleRunStatus } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { decideAlert, type AlertSend, type AlertState } from '../../../src/schedules/alerts/state.js';

const OK: AlertState = { state: 'ok', streak: 0 };

/** Plays `outcomes` from `ok` with `muteAfter`, and returns what each one sent. */
function play(outcomes: readonly ScheduleRunStatus[], muteAfter = 3): (AlertSend | undefined)[] {
  let state = OK;
  return outcomes.map((outcome) => {
    const decision = decideAlert(state, outcome, muteAfter);
    state = decision.next;
    return decision.send;
  });
}

describe('decideAlert (scheduled-runs spec §3.4)', () => {
  it.each([
    ['ok, passed: nothing', OK, 'passed', OK, undefined],
    [
      'ok, failed: failing, streak 1, a failure alert',
      OK,
      'failed',
      { state: 'failing', streak: 1 },
      { kind: 'failure', streak: 1, muted: false },
    ],
    [
      'ok, errored counts as a failure',
      OK,
      'errored',
      { state: 'failing', streak: 1 },
      { kind: 'failure', streak: 1, muted: false },
    ],
    [
      'failing, failed: the streak grows and alerts',
      { state: 'failing', streak: 1 },
      'failed',
      { state: 'failing', streak: 2 },
      { kind: 'failure', streak: 2, muted: false },
    ],
    [
      'failing, passed: recovers, with the streak it ended',
      { state: 'failing', streak: 2 },
      'passed',
      OK,
      { kind: 'recovery', streak: 2 },
    ],
    [
      'failing, skipped: nothing',
      { state: 'failing', streak: 2 },
      'skipped',
      { state: 'failing', streak: 2 },
      undefined,
    ],
    [
      'failing, cancelled: nothing',
      { state: 'failing', streak: 2 },
      'cancelled',
      { state: 'failing', streak: 2 },
      undefined,
    ],
    ['ok, cancelled: nothing', OK, 'cancelled', OK, undefined],
  ] as const)('%s', (_name, previous, outcome, next, send) => {
    expect(decideAlert(previous, outcome, 3)).toEqual(send === undefined ? { next } : { next, send });
  });

  it('alerts up to muteAfter, says so on the last one, then is silent until it recovers', () => {
    expect(play(['failed', 'failed', 'errored', 'failed', 'failed', 'passed'])).toEqual([
      { kind: 'failure', streak: 1, muted: false },
      { kind: 'failure', streak: 2, muted: false },
      { kind: 'failure', streak: 3, muted: true },
      undefined,
      undefined,
      { kind: 'recovery', streak: 5 },
    ]);
  });

  it('muteAfter 1 mutes after the first alert; muteAfter 0 never mutes', () => {
    expect(play(['failed', 'failed', 'passed'], 1)).toEqual([
      { kind: 'failure', streak: 1, muted: true },
      undefined,
      { kind: 'recovery', streak: 2 },
    ]);
    expect(play(['failed', 'failed', 'failed', 'failed'], 0)).toEqual([
      { kind: 'failure', streak: 1, muted: false },
      { kind: 'failure', streak: 2, muted: false },
      { kind: 'failure', streak: 3, muted: false },
      { kind: 'failure', streak: 4, muted: false },
    ]);
  });

  it('skipped and cancelled runs between failures neither break nor grow the streak', () => {
    expect(play(['failed', 'skipped', 'cancelled', 'failed'])).toEqual([
      { kind: 'failure', streak: 1, muted: false },
      undefined,
      undefined,
      { kind: 'failure', streak: 2, muted: false },
    ]);
  });
});
