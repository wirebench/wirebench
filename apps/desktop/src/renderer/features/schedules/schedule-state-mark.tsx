import { XCircle } from 'lucide-react';
import type { ScheduleState } from '../../state/schedules.js';
import { STATE_DOT, STATE_LABEL } from './schedule-format.js';

/**
 * A schedule's state as a small mark: a dot by colour, except a failing schedule, which is a cross —
 * danger must not be told by colour alone, since some colour themes make it amber (#803).
 */
export function ScheduleStateMark({ state }: { readonly state: ScheduleState }) {
  const label = STATE_LABEL[state];
  if (state === 'failing') {
    return (
      <span
        role="img"
        data-testid="schedule-dot"
        data-state={state}
        aria-label={label}
        title={label}
        className="mr-0.5 flex shrink-0 text-status-danger"
      >
        <XCircle size={11} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      role="img"
      data-testid="schedule-dot"
      data-state={state}
      aria-label={label}
      title={label}
      className={`mr-1 h-2 w-2 rounded-full ${STATE_DOT[state]}`}
    />
  );
}
