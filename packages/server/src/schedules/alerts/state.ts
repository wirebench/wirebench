/**
 * A schedule's alert state (scheduled-runs spec §3.4), over finished runs only. The first failure turns a
 * schedule `failing` and alerts; each further failure alerts while the streak is at most `muteAfter`, and
 * the alert at `muteAfter` says later ones are muted; a pass after failures recovers it and always alerts,
 * muted or not. `muteAfter: 0` never mutes. A skipped or cancelled run changes nothing.
 */
import type { ScheduleAlertState, ScheduleRunStatus } from '@wirebench/engine';

export interface AlertState {
  readonly state: ScheduleAlertState;
  readonly streak: number;
}

export type AlertSend =
  | { readonly kind: 'failure'; readonly streak: number; readonly muted: boolean }
  | { readonly kind: 'recovery'; readonly streak: number };

export interface AlertDecision {
  readonly next: AlertState;
  readonly send?: AlertSend;
}

export function decideAlert(previous: AlertState, outcome: ScheduleRunStatus, muteAfter: number): AlertDecision {
  switch (outcome) {
    case 'passed':
      return previous.state === 'failing'
        ? { next: { state: 'ok', streak: 0 }, send: { kind: 'recovery', streak: previous.streak } }
        : { next: previous };
    case 'failed':
    case 'errored': {
      const streak = previous.state === 'failing' ? previous.streak + 1 : 1;
      const next: AlertState = { state: 'failing', streak };
      if (muteAfter > 0 && streak > muteAfter) return { next };
      return { next, send: { kind: 'failure', streak, muted: muteAfter > 0 && streak === muteAfter } };
    }
    default:
      return { next: previous };
  }
}
